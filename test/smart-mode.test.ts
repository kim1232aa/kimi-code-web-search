import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSmartClassifierState,
  classifySmartTurn,
  extractKimiSessionContext,
  extractPromptInput,
  hasUsableSearchProvider,
  resolveSmartCredential,
} from "../hooks/smart-classifier.mjs";
import { externalWebToolKind, isExternalWebToolCall, isExternalWebToolName, isMcpProxyToolName } from "../hooks/mode-state.mjs";
import { LocalStorage } from "../src/host/local-storage.ts";
import { startGatewayServer } from "../src/host/gateway-server.ts";
import { createSearchProvider, type ProviderAdapterLike } from "../src/host/registry.ts";
import type { SearchMode, SmartClassifierProvider } from "../src/shared/api-types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function temporaryHome(t: TestContext): string {
  const base = path.join(ROOT, "temp");
  fs.mkdirSync(base, { recursive: true });
  const home = fs.mkdtempSync(path.join(base, "smart-mode-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function writeWire(home: string, sessionId: string): void {
  const file = path.join(home, "sessions", "wd_test", sessionId, "agents", "main", "wire.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = [
    { type: "turn.prompt", input: "Does the example CLI support this configuration option?" },
    {
      type: "agent.message.appended",
      message: { message: { role: "assistant", content: [{ type: "text", text: "I will inspect the reference." }], toolCalls: [
        { function: { name: "web_search", arguments: JSON.stringify({ query: "example CLI configuration" }) } },
      ] } },
    },
    { type: "context.append_message", message: { role: "tool", content: "Example reference result" } },
    {
      type: "context.append_message",
      message: { role: "assistant", content: [{ type: "text", text: "The example option needs source verification." }] },
    },
    { type: "turn.prompt", input: [{ type: "text", text: "真的吗" }] },
  ];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{incomplete\n`, "utf8");
}

function writeWireEntries(home: string, sessionId: string, entries: unknown[]): void {
  const file = path.join(home, "sessions", "wd_test", sessionId, "agents", "main", "wire.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

interface CapturedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function mockClassifier(t: TestContext, options: {
  probabilities?: { needs_external_lookup: number; involves_tool_or_config_claim: number };
  status?: number;
  hang?: boolean;
} = {}) {
  const requests: CapturedRequest[] = [];
  const probabilities = options.probabilities ?? { needs_external_lookup: 0.9, involves_tool_or_config_claim: 0.1 };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
    if (options.hang) return;
    const response = req.url?.endsWith("/systemone")
      ? { answers: Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, { noul: value }])) }
      : { choices: [{ message: { content: JSON.stringify(probabilities) } }] };
    res.writeHead(options.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function classifierInput(baseUrl: string, provider: SmartClassifierProvider = "typesafe") {
  return {
    promptText: "Verify the example package's latest release.",
    hasImages: false,
    sessionId: "test-classifier-session",
    config: {
      smartSearch: {
        enabled: true,
        provider,
        model: "test-classifier",
        baseUrl,
        timeoutMs: 1000,
        threshold: 0.5,
        failOpen: true,
        enableTranscriptContext: false,
      },
    },
    credentials: {
      WEB_TOOLS_TYPESAFE: "test-classifier-key",
      WEB_TOOLS_OPENROUTER: "test-classifier-key",
      WEB_TOOLS_SMART_CLASSIFIER: "test-classifier-key",
    },
    env: {},
  };
}

test("extractPromptInput handles strings and text/image ContentPart arrays", () => {
  assert.deepEqual(extractPromptInput("hello"), { text: "hello", hasImages: false });
  assert.deepEqual(extractPromptInput([
    { type: "text", text: "Inspect this image" },
    { type: "image_url", image_url: { url: "https://example.org/image.png" } },
    { type: "text", text: "and verify the claim" },
  ]), { text: "Inspect this image\nand verify the claim", hasImages: true });
  assert.deepEqual(extractPromptInput([{ type: "image", image: "test-image" }]), { text: "", hasImages: true });
  assert.deepEqual(extractPromptInput([]), { text: "", hasImages: false });
  assert.deepEqual(extractPromptInput(undefined), { text: "", hasImages: false });
});

test("extractKimiSessionContext recovers wire context for short follow-ups", (t) => {
  const home = temporaryHome(t);
  writeWire(home, "follow-up");
  const context = extractKimiSessionContext("follow-up", home);
  assert.equal(context.lastAssistantReply, "The example option needs source verification.");
  assert.deepEqual(context.recentTools, ["web_search:example CLI configuration"]);
  assert.equal(context.prevUserText, "Does the example CLI support this configuration option?");
  const short = buildSmartClassifierState("真的吗", false, context);
  assert.equal(short.recent_user_context, context.prevUserText);
  assert.equal(short.last_assistant_reply, context.lastAssistantReply);
  assert.deepEqual(short.recent_tools, context.recentTools);
  const long = buildSmartClassifierState("Please inspect the complete example implementation in the current working directory.", false, context);
  assert.equal("recent_user_context" in long, false);
  assert.deepEqual(extractKimiSessionContext("missing-session", home), {});
  assert.deepEqual(extractKimiSessionContext("../follow-up", home), {});
});

for (const provider of ["typesafe", "openrouter", "openai-compatible"] as const) {
  test(`classifySmartTurn calls ${provider} over HTTP and maps probabilities`, async (t) => {
    const mock = await mockClassifier(t);
    const result = await classifySmartTurn(classifierInput(mock.baseUrl, provider));
    assert.equal(result.ok, true);
    assert.equal(result.escalated, true);
    assert.equal(result.provider, provider);
    assert.equal(result.model, "test-classifier");
    assert.deepEqual(result.probabilities, { needs_external_lookup: 0.9, involves_tool_or_config_claim: 0.1 });
    assert.equal(typeof result.latencyMs, "number");
    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0]!;
    assert.equal(request.headers.authorization, "Bearer test-classifier-key");
    assert.equal(request.body.model, "test-classifier");
    if (provider === "typesafe") {
      assert.equal(request.url, "/v1/systemone");
      const questions = request.body.questions as Record<string, { type: string }>;
      assert.equal(questions.needs_external_lookup?.type, "noul");
      assert.equal(questions.involves_tool_or_config_claim?.type, "noul");
      assert.equal((request.body.state as { user_prompt: string }).user_prompt, classifierInput(mock.baseUrl).promptText);
    } else {
      // OpenRouter and openai-compatible backends speak the OpenAI Chat
      // Completions schema (OpenRouter documents only /responses and /chat/completions).
      assert.equal(request.url, "/v1/chat/completions");
      const messages = request.body.messages as Array<{ role: string; content: string }>;
      assert.equal(messages[0]?.role, "system");
      assert.equal(JSON.parse(messages[1]!.content).state.user_prompt, classifierInput(mock.baseUrl).promptText);
    }
  });
}

test("classifySmartTurn does not escalate probabilities below threshold", async (t) => {
  const mock = await mockClassifier(t, { probabilities: { needs_external_lookup: 0.1, involves_tool_or_config_claim: 0.2 } });
  const result = await classifySmartTurn(classifierInput(mock.baseUrl));
  assert.equal(result.ok, true);
  assert.equal(result.escalated, false);
});

test("classifySmartTurn sends wire context and image presence for a short follow-up", async (t) => {
  const home = temporaryHome(t);
  writeWire(home, "follow-up");
  const mock = await mockClassifier(t);
  const input = classifierInput(mock.baseUrl);
  input.promptText = "真的吗";
  input.hasImages = true;
  input.sessionId = "follow-up";
  input.config.smartSearch.enableTranscriptContext = true;
  const result = await classifySmartTurn({ ...input, kimiCodeHome: home });
  assert.equal(result.ok, true);
  const state = mock.requests[0]!.body.state as Record<string, unknown>;
  assert.equal(state.has_images, true);
  assert.equal(state.last_assistant_reply, "The example option needs source verification.");
  assert.equal(state.recent_user_context, "Does the example CLI support this configuration option?");
  assert.deepEqual(state.recent_tools, ["web_search:example CLI configuration"]);
});

test("classifySmartTurn fails open on timeout", async (t) => {
  const mock = await mockClassifier(t, { hang: true });
  const input = classifierInput(mock.baseUrl);
  input.config.smartSearch.timeoutMs = 30;
  const result = await classifySmartTurn(input);
  assert.equal(result.ok, false);
  assert.equal(result.escalated, false);
  assert.equal(result.fallbackReason, "timeout");
  assert.match(result.error ?? "", /timed out/i);
});

test("classifySmartTurn fails open on HTTP 500", async (t) => {
  const mock = await mockClassifier(t, { status: 500 });
  const result = await classifySmartTurn(classifierInput(mock.baseUrl));
  assert.equal(result.ok, false);
  assert.equal(result.escalated, false);
  assert.equal(result.fallbackReason, "http-error");
  assert.match(result.error ?? "", /500/);
  assert.ok(!JSON.stringify(result).includes("test-classifier-key"));
});

test("classifySmartTurn allows keyless loopback openai-compatible endpoints", async (t) => {
  const mock = await mockClassifier(t);
  const input = classifierInput(mock.baseUrl);
  input.config.smartSearch.provider = "openai-compatible";
  const result = await classifySmartTurn({ ...input, credentials: {} });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0]?.headers.authorization, undefined);
});

test("classifySmartTurn fails open without a key and does not send HTTP", async (t) => {
  const mock = await mockClassifier(t);
  const input = classifierInput(mock.baseUrl);
  const result = await classifySmartTurn({ ...input, credentials: {} });
  assert.equal(result.ok, false);
  assert.equal(result.escalated, false);
  assert.equal(result.fallbackReason, "missing-credential");
  assert.equal(mock.requests.length, 0);
});

function hookHome(t: TestContext, mode: SearchMode, config: Record<string, unknown>, credentials: Record<string, string> = {}): string {
  const home = temporaryHome(t);
  writeJson(path.join(home, "web-tools", "mode-state.json"), { globalMode: mode, sessions: {}, updatedAt: Date.now() });
  writeJson(path.join(home, "web-tools", "config.json"), config);
  writeJson(path.join(home, "web-tools", "credentials.json"), credentials);
  return home;
}

async function runHook(
  home: string,
  script: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "hooks", script)], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, KIMI_CODE_HOME: home, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Hook timed out: ${script}`));
    }, 5000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

function storedTurn(home: string, sessionId: string): Record<string, unknown> {
  const document = JSON.parse(fs.readFileSync(path.join(home, "web-tools", "mode-state.json"), "utf8"));
  return document.sessions[sessionId].turn as Record<string, unknown>;
}

function storedSession(home: string, sessionId: string): Record<string, unknown> {
  const document = JSON.parse(fs.readFileSync(path.join(home, "web-tools", "mode-state.json"), "utf8"));
  return document.sessions[sessionId] as Record<string, unknown>;
}

function hookConfig(baseUrl: string): Record<string, unknown> {
  return {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
    recognizeExternalWebTools: false,
    smartSearch: classifierInput(baseUrl).config.smartSearch,
  };
}

test("smart escalated hooks steer once, then stop; stale bindings never hard-fail", async (t) => {
  const mock = await mockClassifier(t);
  const home = hookHome(t, "smart", hookConfig(mock.baseUrl), { WEB_TOOLS_TYPESAFE: "test-classifier-key", WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "smart-escalated";
  const prompt = await runHook(home, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: [{ type: "text", text: "Check the current example CLI docs." }],
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /Web Search is required/);
  assert.match(prompt.stdout, /not an arbitrary query to pass this check/, "the prompt must forbid performative searches");
  assert.match(prompt.stdout, /Reading a URL alone does not count/, "default evidence is a real search");
  assert.match(prompt.stdout, /Any web search counts/, "the prompt must accept any search channel");
  assert.equal(storedTurn(home, sessionId).required, true);
  assert.equal(storedTurn(home, sessionId).smartEscalated, true);

  // A stale or missing binding is advisory: it must never block a legitimate call.
  for (const input of [{}, { session_id: sessionId }, { session_id: "another-session", turn_id: 1 }, { session_id: sessionId, turn_id: 2 }]) {
    const allowed = await runHook(home, "pre-tool-gate.mjs", {
      hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "web_search", tool_call_id: "own-search", tool_input: input,
    });
    assert.equal(allowed.status, 0, `a stale binding must not block the call: ${JSON.stringify(input)}; ${allowed.stderr}`);
  }
  const allowed = await runHook(home, "pre-tool-gate.mjs", {
    hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "web_search", tool_call_id: "own-search",
    tool_input: { query: "example CLI docs", session_id: sessionId, turn_id: 1 },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  const stop = await runHook(home, "stop-turn-gate.mjs", { hook_event_name: "Stop", session_id: sessionId, agent_id: "main" });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /Run any web search/);
  const recursiveStop = await runHook(home, "stop-turn-gate.mjs", {
    hook_event_name: "Stop", session_id: sessionId, agent_id: "main", stop_hook_active: true,
  });
  assert.equal(recursiveStop.status, 0, "a repeated required Stop must exit 0 to prevent infinite loop");
  assert.match(recursiveStop.stdout, /未验证/);
});

test("smart non-escalated hooks allow Stop without research and stay silent", async (t) => {
  const mock = await mockClassifier(t, { probabilities: { needs_external_lookup: 0.1, involves_tool_or_config_claim: 0.1 } });
  const home = hookHome(t, "smart", hookConfig(mock.baseUrl), { WEB_TOOLS_TYPESAFE: "test-classifier-key" });
  const prompt = await runHook(home, "user-prompt-submit.mjs", { hook_event_name: "UserPromptSubmit", session_id: "smart-local", prompt: "hello" });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.equal(prompt.stdout, "", "non-escalated smart turns must stay silent in stdout to avoid terminal noise");
  assert.equal(storedTurn(home, "smart-local").required, false);
  assert.equal(storedTurn(home, "smart-local").smartEscalated, false);
  const stop = await runHook(home, "stop-turn-gate.mjs", { hook_event_name: "Stop", session_id: "smart-local", agent_id: "main" });
  assert.equal(stop.status, 0, stop.stderr);
});

test("smart classifier failures fail open by default but escalate when failOpen is false", async (t) => {
  const mock = await mockClassifier(t, { status: 500 });
  const baseConfig = hookConfig(mock.baseUrl);
  const credentials = { WEB_TOOLS_TYPESAFE: "test-classifier-key", WEB_TOOLS_EXA: "test-search-key" };
  const failClosedHome = hookHome(t, "smart", {
    ...baseConfig,
    smartSearch: { ...(baseConfig.smartSearch as Record<string, unknown>), failOpen: false },
  }, credentials);
  const failClosedPrompt = await runHook(failClosedHome, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit", session_id: "fail-closed", prompt: "Check the current example CLI docs.",
  });
  assert.equal(failClosedPrompt.status, 0, failClosedPrompt.stderr);
  assert.match(failClosedPrompt.stdout, /Web Search is required/);
  assert.equal(storedTurn(failClosedHome, "fail-closed").required, true, "failOpen:false must escalate the turn instead of degrading to auto");
  assert.equal(storedTurn(failClosedHome, "fail-closed").smartEscalated, true);

  const failOpenHome = hookHome(t, "smart", baseConfig, credentials);
  const failOpenPrompt = await runHook(failOpenHome, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit", session_id: "fail-open", prompt: "Check the current example CLI docs.",
  });
  assert.equal(failOpenPrompt.status, 0, failOpenPrompt.stderr);
  assert.equal(storedTurn(failOpenHome, "fail-open").required, false, "the default fail-open keeps the turn unrequired");
  assert.equal(storedTurn(failOpenHome, "fail-open").smartEscalated, false);
});

test("auto mode hooks stay completely silent in stdout to avoid terminal noise", async (t) => {
  const home = hookHome(t, "auto", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-key" });
  const prompt = await runHook(home, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit",
    session_id: "auto-quiet",
    prompt: "A normal user message.",
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.equal(prompt.stdout, "", "auto mode must not pollute terminal stdout on regular turns");
  assert.equal(storedTurn(home, "auto-quiet").required, false);
});

test("required hooks exempt an existing config without usable routes and emit a notice", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true, defaultProvider: "exa", fallbackOrder: [], exemptWhenNoProvider: true,
  });
  const prompt = await runHook(home, "user-prompt-submit.mjs", { hook_event_name: "UserPromptSubmit", session_id: "no-route", prompt: "Check the release." });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /no usable|no available|no web route|无可用/i);
  assert.match(prompt.stdout, /未验证|unverified|could not be verified/i);
  assert.equal(storedTurn(home, "no-route").exempted, true);
  const stop = await runHook(home, "stop-turn-gate.mjs", { hook_event_name: "Stop", session_id: "no-route", agent_id: "main" });
  assert.equal(stop.status, 0, stop.stderr);
});

for (const recognizeExternalWebTools of [true, false]) {
  test(`external web receipts satisfy required Stop only when recognition is ${recognizeExternalWebTools}`, async (t) => {
    const home = hookHome(t, "required", {
      enabled: true, defaultProvider: "exa", exemptWhenNoProvider: false, recognizeExternalWebTools,
    }, { WEB_TOOLS_EXA: "test-search-key" });
    const sessionId = "external-receipt";
    const prompt = await runHook(home, "user-prompt-submit.mjs", { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Check the release." });
    assert.equal(prompt.status, 0, prompt.stderr);
    const pre = await runHook(home, "pre-tool-gate.mjs", {
      hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "mcp__other__web_search", tool_input: { query: "example release" },
    });
    assert.equal(pre.status, 0, pre.stderr);
    const receipt = await runHook(home, "post-tool-receipt.mjs", {
      hook_event_name: "PostToolUse", session_id: sessionId, tool_name: "mcp__other__web_search", tool_call_id: "external-search",
      tool_input: { query: "example release" }, tool_response: { results: [{ url: "https://example.org/releases" }] },
    });
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.equal(Boolean(storedTurn(home, sessionId).externalWebCompleted), recognizeExternalWebTools);
    const stop = await runHook(home, "stop-turn-gate.mjs", { hook_event_name: "Stop", session_id: sessionId, agent_id: "main" });
    assert.equal(stop.status, recognizeExternalWebTools ? 0 : 2, stop.stderr);
    if (recognizeExternalWebTools) assert.equal(stop.stdout.trim(), "", "successful external web receipt must not emit failed-research warning");
  });
}

test("createSearchProvider tries request.provider before its default chain", async () => {
  const calls: string[] = [];
  const adapter = (name: string): ProviderAdapterLike => ({
    name, needsBaseUrl: false, fetchCapable: false,
    search: async () => {
      calls.push(name);
      return { sources: [{ url: `https://example.org/${name}`, title: name }] };
    },
    fetch: async () => ({ text: "unused" }),
  });
  const provider = createSearchProvider(
    () => ({
      enabled: true, defaultProvider: "primary", fallbackOrder: ["secondary"],
      providerAttemptTimeoutMs: 1000, providerBaseUrls: {}, enabledProviders: {},
    }),
    async () => "test-provider-key",
    { record: () => {} },
    { primary: adapter("primary"), secondary: adapter("secondary") },
  );
  const crossCheck = await provider.search({ query: "example release", provider: "secondary" });
  assert.deepEqual(calls, ["secondary"]);
  assert.equal(crossCheck.sources[0]?.url, "https://example.org/secondary");
  calls.length = 0;
  const normal = await provider.search({ query: "example release" });
  assert.deepEqual(calls, ["primary"]);
  assert.equal(normal.sources[0]?.url, "https://example.org/primary");
});

test("smart classifier credentials are never reused across vendors", async (t) => {
  const typesafeOnly = { WEB_TOOLS_TYPESAFE: "test-typesafe-key" };
  assert.deepEqual(resolveSmartCredential({ provider: "typesafe" }, typesafeOnly, {}), {
    apiKey: "test-typesafe-key", ref: "WEB_TOOLS_TYPESAFE", source: "local",
  });
  for (const provider of ["openrouter", "openai-compatible"] as const) {
    assert.deepEqual(resolveSmartCredential({ provider }, typesafeOnly, { WEB_TOOLS_TYPESAFE: "test-typesafe-key" }), {
      apiKey: "", ref: "", source: "none",
    }, `${provider} must not borrow WEB_TOOLS_TYPESAFE`);
  }

  const remote = { ...classifierInput("https://llm.example.org/v1", "openrouter"), credentials: typesafeOnly };
  for (const provider of ["openrouter", "openai-compatible"] as const) {
    let calls = 0;
    const result = await classifySmartTurn({
      ...remote,
      config: { smartSearch: { ...remote.config.smartSearch, provider } },
      fetchImpl: async () => { calls++; throw new Error("unexpected HTTP call"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.fallbackReason, "missing-credential", provider);
    assert.equal(calls, 0, `${provider} must not send the TypeSafe key to another vendor`);
  }

  const mock = await mockClassifier(t);
  const loopback = { ...classifierInput(mock.baseUrl, "openai-compatible"), credentials: typesafeOnly };
  const keyless = await classifySmartTurn(loopback);
  assert.equal(keyless.ok, true);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0]?.headers.authorization, undefined, "TypeSafe key must not reach a compatible endpoint");
});

test("resolveSmartCredential authenticates with one key from a pool and resolves every ref from env too", () => {
  const pooled = resolveSmartCredential({ provider: "typesafe" }, { WEB_TOOLS_TYPESAFE: "pool-first,pool-second" }, {});
  assert.equal(pooled.apiKey, "pool-first", "a comma-joined pool must authenticate with its first key only");
  assert.equal(pooled.source, "local");

  const fromEnv = resolveSmartCredential({ provider: "typesafe" }, {}, { WEB_TOOLS_TYPESAFE: "env-first,env-second" });
  assert.equal(fromEnv.apiKey, "env-first");
  assert.equal(fromEnv.source, "env");

  // Every ref is checked against credentials AND env, not only the last one:
  // OPENROUTER_API_KEY alone must resolve the openrouter provider from env.
  const openrouterEnv = resolveSmartCredential({ provider: "openrouter" }, {}, { OPENROUTER_API_KEY: "or-env-key" });
  assert.deepEqual(openrouterEnv, { apiKey: "or-env-key", ref: "OPENROUTER_API_KEY", source: "env" });
  const openrouterLocal = resolveSmartCredential({ provider: "openrouter" }, { WEB_TOOLS_OPENROUTER: "or-local-key" }, {});
  assert.equal(openrouterLocal.apiKey, "or-local-key");

  assert.deepEqual(resolveSmartCredential({ provider: "typesafe" }, {}, {}), { apiKey: "", ref: "", source: "none" });
});

for (const provider of ["typesafe", "openrouter", "openai-compatible"] as const) {
  for (const baseUrl of ["http://example.org/v1", "https://10.0.0.1/v1", "http://169.254.169.254/latest"]) {
    test(`classifySmartTurn blocks ${baseUrl} for ${provider} without any HTTP call`, async () => {
      let calls = 0;
      const input = {
        ...classifierInput(baseUrl, provider),
        fetchImpl: async () => { calls++; throw new Error("unexpected HTTP call"); },
      };
      const result = await classifySmartTurn(input);
      assert.equal(result.ok, false);
      assert.equal(result.escalated, false);
      assert.equal(result.fallbackReason, "invalid-config");
      assert.equal(calls, 0, "an unsafe endpoint must never be dialed");
      assert.ok(!JSON.stringify(result).includes("test-classifier-key"));
    });
  }
}

test("extractKimiSessionContext ignores injected, hook and system-triggered messages", (t) => {
  const home = temporaryHome(t);
  writeWireEntries(home, "non-human", [
    { type: "turn.prompt", input: "Does the example CLI support this configuration option?", origin: { kind: "user" } },
    {
      type: "agent.message.appended",
      message: { message: { role: "assistant", content: [{ type: "text", text: "Checking the reference." }], toolCalls: [
        { function: { name: "web_search", arguments: JSON.stringify({ query: "example CLI configuration" }) } },
      ] } },
    },
    {
      type: "context.append_message",
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nThe example date changed.\n</system-reminder>" }],
        origin: { kind: "injection", variant: "date_change" },
      },
    },
    { type: "turn.prompt", input: [{ type: "text", text: "Scheduled follow-up trigger" }], origin: { kind: "system_trigger" } },
    {
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "Run the scheduled example task" }], origin: { kind: "system_trigger" } },
    },
    {
      type: "agent.message.appended",
      message: { message: { role: "user", content: "<hook_result>Example hook output</hook_result>" }, meta: { source: "hook" } },
    },
    {
      type: "context.append_message",
      message: { role: "assistant", content: [{ type: "text", text: "The option needs source verification." }] },
    },
    { type: "turn.prompt", input: "真的吗", origin: { kind: "user" } },
  ]);
  const context = extractKimiSessionContext("non-human", home);
  assert.equal(context.prevUserText, "Does the example CLI support this configuration option?");
  assert.equal(context.lastAssistantReply, "The option needs source verification.");
  assert.deepEqual(context.recentTools, ["web_search:example CLI configuration"]);
  const serialized = JSON.stringify(context);
  for (const leaked of ["system-reminder", "date changed", "Scheduled", "scheduled example", "hook"]) {
    assert.ok(!serialized.includes(leaked), `non-human text leaked into context: ${leaked}`);
  }
});

test("extractKimiSessionContext drops the truncated first line of an oversized wire file", (t) => {
  const home = temporaryHome(t);
  const staleQuestion = `Stale question ${"x".repeat(900)}`;
  writeWireEntries(home, "oversized", [
    { type: "turn.prompt", input: staleQuestion, origin: { kind: "user" } },
    { type: "context.append_message", message: { role: "assistant", content: [{ type: "text", text: "Recent reply." }] } },
    { type: "turn.prompt", input: "真的吗", origin: { kind: "user" } },
  ]);
  const whole = extractKimiSessionContext("oversized", home);
  assert.equal(whole.lastAssistantReply, "Recent reply.");
  assert.equal(whole.prevUserText, staleQuestion.slice(0, 250));

  const file = path.join(home, "sessions", "wd_test", "oversized", "agents", "main", "wire.jsonl");
  const maxBytes = fs.statSync(file).size - 400;
  const tail = extractKimiSessionContext("oversized", home, maxBytes);
  assert.equal(tail.lastAssistantReply, "Recent reply.");
  assert.equal(tail.prevUserText, undefined, "a line cut by the byte window must not contribute context");
  assert.ok(!JSON.stringify(tail).includes("xxxx"), "no fragment of the truncated line may leak");
});

test("hasUsableSearchProvider recognizes search keys supplied through the environment", () => {
  const cfg = { enabled: true, defaultProvider: "exa" };
  assert.equal(hasUsableSearchProvider(cfg, {}, {}, undefined, {}), false);
  assert.equal(hasUsableSearchProvider(cfg, {}, {}, undefined, { WEB_TOOLS_EXA: "test-search-key" }), true);
  assert.equal(
    hasUsableSearchProvider({ ...cfg, providerEnabled: { exa: false } }, {}, {}, undefined, { WEB_TOOLS_EXA: "test-search-key" }),
    false,
    "a disabled provider's environment key must not count",
  );
});

test("hooks do not exempt a required turn when a search key exists only in the environment", async (t) => {
  const config = {
    enabled: true, defaultProvider: "exa", fallbackOrder: [], exemptWhenNoProvider: true,
  };
  const withEnv = hookHome(t, "required", config);
  const keyed = await runHook(
    withEnv, "user-prompt-submit.mjs",
    { hook_event_name: "UserPromptSubmit", session_id: "env-key", prompt: "Check the release." },
    { WEB_TOOLS_EXA: "test-search-key" },
  );
  assert.equal(keyed.status, 0, keyed.stderr);
  assert.equal(storedTurn(withEnv, "env-key").exempted, false);
  assert.equal(storedTurn(withEnv, "env-key").required, true);

  const withoutEnv = hookHome(t, "required", config);
  const bare = await runHook(withoutEnv, "user-prompt-submit.mjs", { hook_event_name: "UserPromptSubmit", session_id: "env-key", prompt: "Check the release." });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(storedTurn(withoutEnv, "env-key").exempted, true);
});

test("createSearchProvider rejects an unknown or disabled request.provider", async () => {
  const calls: string[] = [];
  const adapter = (name: string): ProviderAdapterLike => ({
    name, needsBaseUrl: false, fetchCapable: false,
    search: async () => {
      calls.push(name);
      return { sources: [{ url: `https://example.org/${name}`, title: name }] };
    },
    fetch: async () => ({ text: "unused" }),
  });
  const provider = createSearchProvider(
    () => ({
      enabled: true, defaultProvider: "primary", fallbackOrder: ["secondary"],
      providerAttemptTimeoutMs: 1000, providerBaseUrls: {}, enabledProviders: { secondary: false },
    }),
    async () => "test-provider-key",
    { record: () => {} },
    { primary: adapter("primary"), secondary: adapter("secondary") },
  );
  await assert.rejects(provider.search({ query: "example release", provider: "missing" }), /Unknown search provider/);
  await assert.rejects(provider.search({ query: "example release", provider: "secondary" }), /disabled/);
  assert.deepEqual(calls, [], "a rejected provider must not trigger any search");
  const fallback = await provider.search({ query: "example release" });
  assert.equal(fallback.sources[0]?.url, "https://example.org/primary");
});

test("createSearchProvider falls back through the chain when the requested provider fails transiently", async () => {
  const calls: string[] = [];
  const provider = createSearchProvider(
    () => ({
      enabled: true, defaultProvider: "primary", fallbackOrder: ["secondary"],
      providerAttemptTimeoutMs: 1000, providerBaseUrls: {}, enabledProviders: {},
    }),
    async () => "test-provider-key",
    { record: () => {} },
    {
      primary: {
        name: "primary", needsBaseUrl: false, fetchCapable: false,
        search: async () => {
          calls.push("primary");
          return { sources: [{ url: "https://example.org/primary", title: "primary" }] };
        },
        fetch: async () => ({ text: "unused" }),
      },
      secondary: {
        name: "secondary", needsBaseUrl: false, fetchCapable: false,
        search: async () => {
          calls.push("secondary");
          throw Object.assign(new Error("temporary upstream failure"), { code: "server" });
        },
        fetch: async () => ({ text: "unused" }),
      },
    },
  );
  const result = await provider.search({ query: "example release", provider: "secondary" });
  assert.deepEqual(calls, ["secondary", "primary"]);
  assert.equal(result.sources[0]?.url, "https://example.org/primary");
});

test("/web-tools/mcp/status reports lastSmartDecision after a smart hook turn", async (t) => {
  const mock = await mockClassifier(t);
  const home = hookHome(t, "smart", hookConfig(mock.baseUrl), { WEB_TOOLS_TYPESAFE: "test-classifier-key", WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "status-smart";
  const prompt = await runHook(home, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Check the current example CLI docs.",
  });
  assert.equal(prompt.status, 0, prompt.stderr);

  const handle = await startGatewayServer({ host: "127.0.0.1", port: 0, baseDir: path.join(home, "web-tools"), projectRoot: ROOT });
  t.after(() => handle.close());
  const response = await fetch(`${handle.url}/web-tools/mcp/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; value: { lastSmartDecision?: Record<string, unknown>; mode: { smartDecision?: unknown } } };
  assert.equal(body.ok, true);
  const decision = body.value.lastSmartDecision;
  assert.ok(decision, "status must expose the last smart decision");
  assert.equal(decision.escalated, true);
  assert.equal(decision.mode, "required");
  assert.equal(decision.provider, "typesafe");
  assert.equal(decision.model, "test-classifier");
  assert.deepEqual(decision.probabilities, { needs_external_lookup: 0.9, involves_tool_or_config_claim: 0.1 });
  assert.deepEqual(body.value.mode.smartDecision, decision);
  assert.ok(!JSON.stringify(body).includes("test-classifier-key"), "status must not expose classifier credentials");
});

test("user-prompt-submit advertises ready search providers without leaking secrets", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "tavily",
    fallbackOrder: ["exa"],
    exemptWhenNoProvider: false,
    recognizeExternalWebTools: true,
  }, { WEB_TOOLS_TAVILY: "tvly-secret-val", WEB_TOOLS_EXA: "exa-secret-val" });
  const prompt = await runHook(home, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit",
    session_id: "hint-test",
    prompt: "Compare docs.",
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /Ready search providers \(for web_search provider=\.\.\.\): tavily, exa\./);
  assert.match(prompt.stdout, /Recognized external web search tools also satisfy this turn\./);
  assert.match(prompt.stdout, /web_mode.*do NOT count/i);
  assert.ok(!prompt.stdout.includes("tvly-secret-val") && !prompt.stdout.includes("exa-secret-val"));
});

test("external web tool recognition matches MCP servers, unwraps proxies, and rejects local helpers", () => {
  for (const name of [
    "FetchURL",
    "SearchWeb",
    "mcp__exa__web_search_exa",
    "mcp__exa__web_fetch_exa",
    "mcp__exa__web_search_advanced_exa",
    "mcp__tavily__tavily-search",
    "mcp__tavily__tavily-extract",
    "mcp__firecrawl__firecrawl_scrape",
    "mcp__brave__brave_web_search",
    "mcp__brave__brave_llm_context",
    "mcp__perplexity__perplexity_ask",
    "source_check",
    "agy-websearch_search_web",
    "mcp__fetch__fetch",
    "mcp__serpapi__search",
  ]) {
    assert.equal(isExternalWebToolName(name), true, `${name} should be recognized`);
  }

  for (const name of [
    "web_search",
    "mcp__web__web_search",
    "mcp__plugin-web_s__web_search",
    "mcp__plugin-web_s__web_fetch",
    "mcp__plugin-kimi-code-web-search_web__web_search",
    "web_fetch",
    "web_enable",
    "get_search_content",
    "select_tools",
    "web_mode",
    "web_status",
    "git_fetch",
    "file_search",
    "code_search",
    "mcp__github__search_code",
    "mcp__firecrawl__firecrawl_credit_usage",
  ]) {
    assert.equal(isExternalWebToolName(name), false, `${name} must NOT be recognized as external web tool`);
  }

  assert.equal(isMcpProxyToolName("mcp"), true);
  assert.equal(isMcpProxyToolName("mcp__agy_websearch"), true);
  assert.equal(isMcpProxyToolName("mcp__exa__web_search_exa"), false);

  assert.equal(isExternalWebToolCall("mcp", { tool: "search_web", args: { query: "test" } }), true);
  assert.equal(isExternalWebToolCall("mcp__agy_websearch", { tool: "web_search", args: { query: "test" } }), true);
  assert.equal(isExternalWebToolCall("mcp", { search: "web search" }), false);
  assert.equal(isExternalWebToolCall("mcp", { tool: "filesystem_read" }), false);
  assert.equal(isExternalWebToolCall("mcp", { tool: "web_enable" }), false);
});

test("external web tools are classified as search or page read, arguments first", () => {
  const cases: Array<[string, Record<string, unknown>, "search" | "fetch" | undefined]> = [
    ["FetchURL", { url: "https://example.org" }, "fetch"],
    ["SearchWeb", { query: "example release notes" }, "search"],
    ["mcp__exa__web_search_exa", { query: "example" }, "search"],
    ["mcp__exa__web_fetch_exa", { urls: ["https://example.org"] }, "fetch"],
    ["mcp__exa__crawling_exa", { url: "https://example.org" }, "fetch"],
    ["mcp__exa__deep_search_exa", { objective: "example" }, "search"],
    ["mcp__tavily__tavily_search", {}, "search"],
    ["mcp__tavily__tavily_extract", { urls: ["https://example.org"], query: "rerank chunks" }, "fetch"],
    ["mcp__tavily__tavily_research", { input: "example" }, "search"],
    ["mcp__firecrawl__firecrawl_scrape", { url: "https://example.org" }, "fetch"],
    ["mcp__firecrawl__firecrawl_search", { query: "example" }, "search"],
    ["mcp__firecrawl__firecrawl_developer_search", { query: "example" }, "search"],
    ["mcp__brave__brave_image_search", { query: "example" }, "search"],
    ["mcp__brave__brave_llm_context", { query: "example" }, "search"],
    ["mcp__perplexity__perplexity_ask", { messages: [] }, "search"],
    ["mcp__agy-search__search_web", { query: "site:example.org docs" }, "search"],
    ["mcp__jina__read_url", { url: "https://example.org" }, "fetch"],
    ["mcp__jina__search_web", { query: "https://example.org/page" }, "fetch"],
    ["mcp", { tool: "search_web", args: { query: "example" } }, "search"],
    ["mcp__agy_websearch", { tool: "search_web", args: { url: "https://example.org" } }, "fetch"],
    ["mcp", { tool: "web_fetch" }, "fetch"],
    ["mcp__fetch__fetch", { query: "example" }, "fetch"],
    ["FetchURL", { query: "example" }, "fetch"],
    ["source_check", { query: "example claim" }, "search"],
    ["source_check", { url: "https://example.org" }, "fetch"],
    ["mcp__firecrawl__firecrawl_search_feedback", { query: "example" }, undefined],
    ["mcp__firecrawl__firecrawl_check_crawl_status", { id: "job" }, undefined],
    ["mcp__firecrawl__firecrawl_map", { url: "https://example.org" }, undefined],
    ["mcp__github__search_code", { query: "example" }, undefined],
    ["mcp__memory__search_nodes", { query: "example" }, undefined],
    ["web_search", { query: "own tool" }, undefined],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(externalWebToolKind(name, input), expected, `${name} ${JSON.stringify(input)}`);
  }
});

test("requiredEvidence defaults to search: a URL read alone gets one correction, search-or-fetch accepts it", async (t) => {
  for (const [requiredEvidence, settles] of [[undefined, false], ["search-or-fetch", true]] as const) {
    const home = hookHome(t, "required", {
      enabled: true,
      defaultProvider: "exa",
      exemptWhenNoProvider: false,
      ...(requiredEvidence ? { requiredEvidence } : {}),
    }, { WEB_TOOLS_EXA: "test-search-key" });
    const sessionId = `evidence-${requiredEvidence ?? "default"}`;
    const prompt = await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Read the docs page." });
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.match(prompt.stdout, settles ? /Any web search or page read counts/ : /Reading a URL alone does not count/);
    assert.equal(storedTurn(home, sessionId).requiredEvidence, requiredEvidence ?? "search");

    new LocalStorage(path.join(home, "web-tools")).completeTool(sessionId, "web_fetch", true, 1);
    const receipt = await runHook(home, "post-tool-receipt.mjs", {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "FetchURL",
      tool_input: { url: "https://example.org/docs" },
      tool_output: "Example documentation",
    });
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.equal(storedTurn(home, sessionId).externalWebCompleted, true);
    assert.equal(storedTurn(home, sessionId).externalSearchCompleted, false);

    const stop = await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId });
    if (settles) {
      assert.equal(stop.status, 0, stop.stderr);
      continue;
    }
    assert.equal(stop.status, 2);
    assert.match(stop.stderr, /Run any web search before finalizing/);
    assert.match(stop.stderr, /Reading a URL alone does not satisfy this turn/);

    const search = await runHook(home, "post-tool-receipt.mjs", {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "mcp__exa__web_search_exa",
      tool_input: { query: "example docs" },
      tool_output: "Title: Example docs\nURL: https://example.org/docs",
    });
    assert.equal(search.status, 0, search.stderr);
    assert.equal(storedTurn(home, sessionId).externalSearchCompleted, true);
    const settled = await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId });
    assert.equal(settled.status, 0, settled.stderr);
    assert.equal(settled.stdout.trim(), "");
  }
});

test("text-only provider errors count as failed and an all-failed turn is steered once to switch sources", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "all-failed";
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Check the CLI flags." });

  const failed = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "mcp__agy-search__search_web",
    tool_input: { query: "example cli print mode flags" },
    tool_output: "## Google (google) — example cli print mode flags\n\nError: Grounding API error: HTTP 403 - {",
  });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(storedTurn(home, sessionId).externalSearchCompleted, true);
  assert.equal(storedTurn(home, sessionId).externalSearchSucceeded, false);

  const steer = await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId });
  assert.equal(steer.status, 2);
  assert.match(steer.stderr, /Every web search this turn failed/);
  assert.match(steer.stderr, /switch to another source or another search tool/);

  const finalStop = await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId });
  assert.equal(finalStop.status, 0, "the correction budget is one per turn");
  assert.match(finalStop.stdout, /未验证/);

  const partial = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "mcp__agy-search__search_web",
    tool_input: { query: "example cli print mode flags" },
    tool_output: "## Google (google) — q\n\nError: HTTP 403\n\n## Exa (exa) — q\n\n1. Example CLI reference https://example.org/cli",
  });
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(storedTurn(home, sessionId).externalSearchSucceeded, true, "one working source among failures is a success");

  await runHook(home, "user-prompt-submit.mjs", { session_id: "error-topic", prompt: "Explain error handling." });
  const docs = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "error-topic",
    tool_name: "mcp__exa__web_search_exa",
    tool_input: { query: "rust error handling" },
    tool_output: "Error handling in Rust uses Result<T, E>.",
  });
  assert.equal(docs.status, 0, docs.stderr);
  assert.equal(storedTurn(home, "error-topic").externalSearchSucceeded, true, "a result about errors is not a failed call");
});

test("external web proxy calls and missing config.json default to enabled receipt recognition and no-route exemption", async (t) => {
  const home = temporaryHome(t);
  writeJson(path.join(home, "web-tools", "mode-state.json"), { globalMode: "required", sessions: {}, updatedAt: Date.now() });
  const sessionId = "default-external";

  const prompt = await runHook(home, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "Check docs.",
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /Recognized external web search tools also satisfy this turn\./);

  const receipt = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "mcp__agy_websearch",
    tool_input: { tool: "search_web", args: { query: "example" } },
  });
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.equal(storedTurn(home, sessionId).externalWebCompleted, true);
  assert.equal((await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId, agent_id: "main" })).status, 0);

  // When config.json exists with empty credentials and omitted flags, exemptWhenNoProvider defaults to true
  writeJson(path.join(home, "web-tools", "config.json"), {
    enabled: true,
    defaultProvider: "exa",
    fallbackOrder: [],
  });
  const exempted = await runHook(home, "user-prompt-submit.mjs", {
    hook_event_name: "UserPromptSubmit",
    session_id: "default-exempt",
    prompt: "Check docs.",
  });
  assert.equal(exempted.status, 0, exempted.stderr);
  assert.equal(storedTurn(home, "default-exempt").exempted, true);
});

test("UserPromptSubmit preserves turn state on is_steer; subagent activity resets on new turn", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "steer-subagent";

  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Check release." });
  const storage = new LocalStorage(path.join(home, "web-tools"));
  storage.completeTool(sessionId, "web_search", true, 1);

  const steer = await runHook(home, "user-prompt-submit.mjs", {
    session_id: sessionId,
    prompt: "Also check changelog.",
    is_steer: true,
  });
  assert.equal(steer.status, 0, steer.stderr);
  assert.equal(storedTurn(home, sessionId).turn, 1, "is_steer must not increment turn_id");
  assert.equal(storedTurn(home, sessionId).webSearchCompleted, true, "is_steer must preserve completion receipt");

  await runHook(home, "subagent-activity.mjs", {
    hook_event_name: "SubagentStart",
    session_id: sessionId,
    agent_name: "explore",
  });
  assert.equal(storedSession(home, sessionId).activeSubagents, 1);

  // A genuine new user turn resets the counter: failed or cancelled subagents
  // never fire SubagentStop, so this is the leak repair.
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Next question." });
  assert.equal(storedSession(home, sessionId).activeSubagents, 0);
  assert.equal(storedTurn(home, sessionId).turn, 2, "a genuine prompt starts a new turn");
});

test("Stop gate stays silent while a subagent is active and resumes after SubagentStop", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "subagent-stop";
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Research docs." });

  // Kimi Stop payloads carry no agent identity; a subagent's turn-end shares
  // the session_id and must not consume the main turn's correction budget.
  await runHook(home, "subagent-activity.mjs", {
    hook_event_name: "SubagentStart",
    session_id: sessionId,
    agent_name: "coder",
  });
  const subagentStop = await runHook(home, "stop-turn-gate.mjs", {
    hook_event_name: "Stop",
    session_id: sessionId,
    stop_hook_active: false,
  });
  assert.equal(subagentStop.status, 0, subagentStop.stderr);
  assert.equal(subagentStop.stdout.trim(), "", "an active subagent's Stop must not emit an unverified reminder");
  assert.equal(storedTurn(home, sessionId).correctionCount, 0, "a subagent Stop must not consume the correction budget");

  await runHook(home, "subagent-activity.mjs", {
    hook_event_name: "SubagentStop",
    session_id: sessionId,
    agent_name: "coder",
  });
  assert.equal(storedSession(home, sessionId).activeSubagents, 0);

  const mainStop = await runHook(home, "stop-turn-gate.mjs", {
    hook_event_name: "Stop",
    session_id: sessionId,
    stop_hook_active: false,
  });
  assert.equal(mainStop.status, 2, "the main Stop must steer again once the subagent finished");
  assert.match(mainStop.stderr, /Web Search is required/);
  assert.equal(storedTurn(home, sessionId).correctionCount, 1);
});

test("SubagentStop without a matching SubagentStart never decrements below zero", async (t) => {
  const home = hookHome(t, "auto", {});
  const sessionId = "subagent-floor";
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Hi." });
  const stop = await runHook(home, "subagent-activity.mjs", {
    hook_event_name: "SubagentStop",
    session_id: sessionId,
    agent_name: "coder",
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(storedSession(home, sessionId).activeSubagents ?? 0, 0);
});

test("system-trigger turns skip the Stop gate once and user turns clear the marker", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "system-turn";
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Research docs." });
  assert.equal(storedSession(home, sessionId).systemTurnPending, false);

  // A background-task wake-up starts a turn with no user prompt.
  await runHook(home, "turn-start.mjs", {
    hook_event_name: "TurnStarted",
    session_id: sessionId,
    origin_kind: "system_trigger",
    origin_name: "task.completed",
  });
  assert.equal(storedSession(home, sessionId).systemTurnPending, true);

  const skipped = await runHook(home, "stop-turn-gate.mjs", {
    hook_event_name: "Stop",
    session_id: sessionId,
    stop_hook_active: false,
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout.trim(), "", "a system-trigger turn-end must not emit an unverified reminder");
  assert.equal(storedTurn(home, sessionId).correctionCount, 0, "a system-trigger turn-end must not consume the correction budget");
  assert.equal(storedSession(home, sessionId).systemTurnPending, false, "the marker is consumed by one Stop");

  const mainStop = await runHook(home, "stop-turn-gate.mjs", {
    hook_event_name: "Stop",
    session_id: sessionId,
    stop_hook_active: false,
  });
  assert.equal(mainStop.status, 2, "the next real turn-end is gated again");
  assert.match(mainStop.stderr, /Web Search is required/);

  // A fresh user prompt resets a stale marker, e.g. after a failed system turn.
  await runHook(home, "turn-start.mjs", {
    hook_event_name: "TurnStarted",
    session_id: sessionId,
    origin_kind: "system_trigger",
  });
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Next question." });
  assert.equal(storedSession(home, sessionId).systemTurnPending, false);
});

test("SessionEnd removes ephemeral turn state but keeps explicit mode overrides", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const statePath = path.join(home, "web-tools", "mode-state.json");
  const readDoc = () => JSON.parse(fs.readFileSync(statePath, "utf8"));

  await runHook(home, "user-prompt-submit.mjs", { session_id: "closing-session", prompt: "Check docs." });
  assert.ok(readDoc().sessions["closing-session"].turn);

  await runHook(home, "session-end.mjs", {
    hook_event_name: "SessionEnd",
    session_id: "closing-session",
    source: "exit",
  });
  assert.equal(Object.hasOwn(readDoc().sessions, "closing-session"), false, "ephemeral turn state is removed on SessionEnd");

  const storage = new LocalStorage(path.join(home, "web-tools"));
  storage.setSessionMode("override-me", "off");
  await runHook(home, "user-prompt-submit.mjs", { session_id: "override-me", prompt: "Hi." });
  await runHook(home, "session-end.mjs", { hook_event_name: "SessionEnd", session_id: "override-me" });
  assert.equal(readDoc().sessions["override-me"]?.mode, "off", "a user mode override must survive SessionEnd");
});

test("newTurn prunes stale non-override sessions but keeps overrides and fresh entries", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const statePath = path.join(home, "web-tools", "mode-state.json");
  const now = Date.now();
  const stale = now - 40 * 24 * 60 * 60 * 1000;
  writeJson(statePath, {
    globalMode: "required",
    sessions: {
      stale: { turn: { turn: 1 }, updatedAt: stale },
      fresh: { turn: { turn: 1 }, updatedAt: now - 60 * 60 * 1000 },
      "keep-override": { mode: "off", turn: { turn: 1 }, updatedAt: stale },
    },
    updatedAt: now,
  });

  await runHook(home, "user-prompt-submit.mjs", { session_id: "prune-trigger", prompt: "Hi." });
  const doc = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(doc.sessions.stale, undefined, "crashed sessions without SessionEnd are pruned after 30 days");
  assert.ok(doc.sessions.fresh, "recent sessions are kept");
  assert.equal(doc.sessions["keep-override"].mode, "off", "overrides are never pruned");
  assert.ok(doc.sessions["prune-trigger"].turn);
});

test("a subagent call without a binding still counts toward the parent turn when bound", async (t) => {
  const home = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
    recognizeExternalWebTools: true,
    requiredEvidence: "search-or-fetch",
  }, { WEB_TOOLS_EXA: "test-search-key" });
  const sessionId = "parent-sess";
  await runHook(home, "user-prompt-submit.mjs", { session_id: sessionId, prompt: "Research docs." });

  const unbound = await runHook(home, "pre-tool-gate.mjs", {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    agent_id: "agent-coder-1",
    tool_name: "mcp__plugin-web_s__web_search",
    tool_call_id: "sub-call-1",
    tool_input: { query: "example docs" },
  });
  assert.equal(unbound.status, 0, "a subagent call is never blocked for lacking a binding");

  const storage = new LocalStorage(path.join(home, "web-tools"));
  assert.doesNotThrow(() => storage.bindToolTurn("global"));
  assert.equal(storedTurn(home, sessionId).webSearchCompleted, false);

  const ownReceipt = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    agent_id: "agent-coder-1",
    tool_name: "mcp__plugin-web_s__web_search",
    tool_input: { query: "example docs" },
    tool_response: { isError: true },
  });
  assert.equal(ownReceipt.status, 0, ownReceipt.stderr);
  assert.equal(storedTurn(home, sessionId).webSearchCompleted, false, "an own-tool hook receipt must not bypass gateway turn binding");

  const failedExternal = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUseFailure",
    session_id: sessionId,
    tool_name: "FetchURL",
    tool_input: { url: "https://example.org/docs" },
    tool_response: { isError: true },
  });
  assert.equal(failedExternal.status, 0, failedExternal.stderr);
  assert.equal(storedTurn(home, sessionId).externalWebCompleted, true, "a failed external call still counts as attempted");
  assert.equal(storedTurn(home, sessionId).externalWebSucceeded, false);
  const failedStop = await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId, agent_id: "main" });
  assert.equal(failedStop.status, 2, "an all-failed turn gets one correction to switch sources");
  assert.match(failedStop.stderr, /Every web lookup this turn failed/);
  assert.match(failedStop.stderr, /switch to another source or another search tool/);

  // Subsequent successful external call in the same turn must turn externalWebSucceeded to true
  const succeededExternal = await runHook(home, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "FetchURL",
    tool_input: { url: "https://example.org/valid-docs" },
    tool_response: { text: "valid documentation content", ok: true },
  });
  assert.equal(succeededExternal.status, 0, succeededExternal.stderr);
  assert.equal(storedTurn(home, sessionId).externalWebCompleted, true);
  assert.equal(storedTurn(home, sessionId).externalWebSucceeded, true, "successful retry must clear unverified status");
  const cleanStop = await runHook(home, "stop-turn-gate.mjs", { session_id: sessionId, agent_id: "main" });
  assert.equal(cleanStop.status, 0, cleanStop.stderr);
  assert.equal(cleanStop.stdout.trim(), "", "clean success must not emit unverified warning");

  storage.setSessionMode(sessionId, "off");
  const subOff = await runHook(home, "pre-tool-gate.mjs", {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    agent_id: "agent-coder-1",
    tool_name: "mcp__plugin-web_s__web_search",
    tool_input: { query: "example docs", session_id: sessionId, turn_id: 1 },
  });
  assert.equal(subOff.status, 2);
});
