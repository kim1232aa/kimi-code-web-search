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
import {
  classifyOwnTool,
  externalWebToolKind,
  isExternalWebToolCall,
  isExternalWebToolName,
  isMcpProxyToolName,
} from "../hooks/mode-state.mjs";
import { usableSearchRoutes } from "../hooks/smart-classifier.mjs";
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
  const home = hookHome(t, "smart", { ...hookConfig(mock.baseUrl), recognizeExternalWebTools: true }, { WEB_TOOLS_TYPESAFE: "test-classifier-key", WEB_TOOLS_EXA: "test-search-key" });
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

  await runHook(home, "subagent-activity.mjs", {
    hook_event_name: "SubagentStart",
    session_id: sessionId,
    agent_name: "agent-coder-1",
  });

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

  await runHook(home, "subagent-activity.mjs", {
    hook_event_name: "SubagentStop",
    session_id: sessionId,
    agent_name: "agent-coder-1",
  });

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

test("ownKindOfServer excludes external web-remote/my-web servers and CamelCase external tools match", () => {
  for (const own of [
    "web_search",
    "web_fetch",
    "mcp__web__web_search",
    "mcp__kimi-web-tools__web_search",
    "mcp__kimi-code-web-search__web_fetch",
    "mcp__plugin-web_s__web_search",
    "mcp__plugin-kimi-web-tools_s__web_search",
    "mcp__plugin-kimi-code-web-search_web__web_fetch",
  ]) {
    assert.ok(classifyOwnTool(own), `${own} must classify as own tool`);
  }

  for (const external of [
    "mcp__web-remote__web_search",
    "mcp__web-remote__web_fetch",
    "mcp__my-web__web_search",
    "mcp__exa__deepSearchExa",
    "mcp__tavily__tavilySearch",
    "mcp__perplexity__perplexityAsk",
  ]) {
    assert.equal(classifyOwnTool(external), undefined, `${external} must NOT classify as own tool`);
    assert.equal(isExternalWebToolName(external), true, `${external} must classify as external web tool`);
  }
  assert.equal(externalWebToolKind("mcp__exa__deepSearchExa", { objective: "latest spec" }), "search");
  assert.equal(externalWebToolKind("mcp__tavily__tavilySearch", { query: "latest spec" }), "search");
  assert.equal(externalWebToolKind("mcp__web-remote__web_search", { query: "latest spec" }), "search");
  assert.equal(externalWebToolKind("mcp__web-remote__web_fetch", { url: "https://example.org" }), "fetch");
});

test("usableSearchRoutes ignores stale browser-profiles and requires providerBaseUrls.searxng", (t) => {
  const home = temporaryHome(t);
  writeJson(path.join(home, "web-tools", "browser-profiles", "xiaohongshu", "dsh-profile-meta.json"), { authenticated: true });
  writeJson(path.join(home, "web-tools", "browser-profiles", "x", "dsh-profile-meta.json"), { sessionEstablished: true });

  const noUrl = usableSearchRoutes({ enabled: true, defaultProvider: "searxng" }, { WEB_TOOLS_SEARXNG: "token" }, undefined, home, {});
  assert.deepEqual(noUrl, { webProviders: [], platforms: [] });
  assert.equal(hasUsableSearchProvider({ enabled: true, defaultProvider: "searxng" }, {}, undefined, home, { WEB_TOOLS_SEARXNG: "token" }), false);

  const withUrl = usableSearchRoutes({ enabled: true, providerBaseUrls: { searxng: "https://searx.example.org" } }, {}, undefined, home, {});
  assert.deepEqual(withUrl, { webProviders: ["searxng"], platforms: [] });
});

test("remote gateway skips no-key exemption, auto mode stays silent without keys, and recognizeExternalWebTools=false hides external hints", async (t) => {
  // 1. Auto mode without keys stays completely silent
  const autoHome = hookHome(t, "auto", { enabled: true, defaultProvider: "exa", exemptWhenNoProvider: true });
  const autoPrompt = await runHook(autoHome, "user-prompt-submit.mjs", { session_id: "auto-no-key", prompt: "hello" });
  assert.equal(autoPrompt.status, 0, autoPrompt.stderr);
  assert.equal(autoPrompt.stdout, "");
  assert.equal(storedTurn(autoHome, "auto-no-key").exempted, false);

  // 2. Remote gateway in required mode does not exempt even when local config.json has no keys
  const remoteHome = hookHome(t, "required", { enabled: true, defaultProvider: "exa", exemptWhenNoProvider: true });
  const remotePrompt = await runHook(
    remoteHome,
    "user-prompt-submit.mjs",
    { session_id: "remote-req", prompt: "check docs" },
    { KIMI_WEB_TOOLS_GATEWAY_URL: "https://gw.example.org" },
  );
  assert.equal(remotePrompt.status, 0, remotePrompt.stderr);
  assert.equal(storedTurn(remoteHome, "remote-req").exempted, false);
  assert.equal(storedTurn(remoteHome, "remote-req").required, true);
  assert.match(remotePrompt.stdout, /Web Search is required/);
  assert.doesNotMatch(remotePrompt.stdout, /Ready search providers/);

  // 3. recognizeExternalWebTools: false hides external tool mentions in both UserPromptSubmit and Stop
  const strictHome = hookHome(t, "required", {
    enabled: true,
    defaultProvider: "exa",
    exemptWhenNoProvider: false,
    recognizeExternalWebTools: false,
  }, { WEB_TOOLS_EXA: "test-key" });
  const strictPrompt = await runHook(strictHome, "user-prompt-submit.mjs", { session_id: "strict-own", prompt: "check docs" });
  assert.equal(strictPrompt.status, 0, strictPrompt.stderr);
  assert.doesNotMatch(strictPrompt.stdout, /WebSearch|FetchURL|another search MCP|Any web search counts|Any search path counts/);
  assert.equal(storedTurn(strictHome, "strict-own").recognizeExternal, false);

  const strictStop = await runHook(strictHome, "stop-turn-gate.mjs", { session_id: "strict-own" });
  assert.equal(strictStop.status, 2);
  assert.doesNotMatch(strictStop.stderr, /WebSearch|FetchURL|another search MCP/);
  assert.match(strictStop.stderr, /this plugin's `web_search`/);
});

test("smart classifier trims short follow-ups, extracts output_text, and parses JSON preceded by braces in prose", async (t) => {
  const home = temporaryHome(t);
  writeWire(home, "trim-test");
  const context = extractKimiSessionContext("trim-test", home);

  const shortPadded = buildSmartClassifierState("  真的吗  \n", false, context);
  assert.equal(shortPadded.recent_user_context, context.prevUserText);
  const longPadded = buildSmartClassifierState(`  ${"x".repeat(25)}  `, false, context);
  assert.equal("recent_user_context" in longPadded, false);

  assert.deepEqual(extractPromptInput([
    { type: "output_text", text: "First" },
    { output_text: "Second" },
    { type: "think", text: "ignored" },
  ]), { text: "First\nSecond", hasImages: false });

  const result = await classifySmartTurn({
    ...classifierInput("https://llm.example.org/v1", "openrouter"),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: [
              {
                type: "output_text",
                text: 'Considering {user_prompt} and {unclosed prose:\n{"needs_external_lookup": 0.85, "involves_tool_or_config_claim": 0.2}\nNote: {done}',
              },
            ],
          },
        }],
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.deepEqual(result.probabilities, { needs_external_lookup: 0.85, involves_tool_or_config_claim: 0.2 });
});

test("remote gateway evaluates Smart (Jev) turn remotely, syncs mode & policy to clean client via remote.json, and credits remote search", async (t) => {
  const classifier = await mockClassifier(t, {
    probabilities: { needs_external_lookup: 0.96, involves_tool_or_config_claim: 0.1 },
  });
  const gatewayHome = temporaryHome(t);
  const gatewayDir = path.join(gatewayHome, "web-tools");
  writeJson(path.join(gatewayDir, "config.json"), {
    enabled: true,
    defaultProvider: "exa",
    fallbackOrder: ["tavily"],
    exemptWhenNoProvider: true,
    recognizeExternalWebTools: false,
    requiredEvidence: "search-or-fetch",
    smartSearch: {
      enabled: true,
      provider: "typesafe",
      model: "jev-latest",
      baseUrl: classifier.baseUrl,
      timeoutMs: 2000,
      threshold: 0.5,
      failOpen: true,
      enableTranscriptContext: true,
    },
  });
  writeJson(path.join(gatewayDir, "credentials.json"), {
    WEB_TOOLS_EXA: "remote-exa-key",
    WEB_TOOLS_TYPESAFE: "remote-jev-key",
  });
  const gatewayStorage = new LocalStorage(gatewayDir);
  gatewayStorage.setSessionMode("global", "smart");

  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir: gatewayDir,
    password: "remote-gw-password",
  });
  t.after(() => handle.close());

  // Clean Windows-like client: NO local config.json, NO local keys, local mode defaults to "auto",
  // connected via remote.json (no KIMI_WEB_TOOLS_GATEWAY_URL env var needed).
  const clientHome = temporaryHome(t);
  writeJson(path.join(clientHome, "web-tools", "remote.json"), {
    url: handle.url,
    token: "remote-gw-password",
  });
  const sessionId = "remote-smart-session";
  writeWire(clientHome, sessionId);

  const prompt = await runHook(clientHome, "user-prompt-submit.mjs", {
    session_id: sessionId,
    prompt: "真的吗",
  });
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.match(prompt.stdout, /\[Smart Mode: Escalated to Required Web Search\]/);
  assert.match(prompt.stdout, /Ready search providers \(for web_search provider=\.\.\.\): exa\./);
  assert.doesNotMatch(prompt.stdout, /WebSearch|another search MCP/, "remote recognizeExternalWebTools=false must sync to client");

  // Verify the remote classifier actually received client wire.jsonl short-followup context
  assert.equal(classifier.requests.length, 1);
  assert.equal(classifier.requests[0].headers.authorization, "Bearer remote-jev-key");
  const state = classifier.requests[0].body.state as Record<string, unknown>;
  assert.equal(state.user_prompt, "真的吗");
  assert.equal(typeof state.recent_user_context, "string");
  assert.ok((state.recent_user_context as string).length > 0, "client wire context must reach remote classifier");

  // Local mode-state.json must have synced globalMode=smart, required=true, requiredEvidence=search-or-fetch, recognizeExternal=false
  const clientDoc = JSON.parse(fs.readFileSync(path.join(clientHome, "web-tools", "mode-state.json"), "utf8"));
  assert.equal(clientDoc.globalMode, "smart");
  assert.equal(clientDoc.sessions[sessionId].turn.required, true);
  assert.equal(clientDoc.sessions[sessionId].turn.requiredEvidence, "search-or-fetch");
  assert.equal(clientDoc.sessions[sessionId].turn.recognizeExternal, false);

  // Gateway also recorded lastSmartDecision for dashboard/status visibility
  const gatewayDoc = gatewayStorage.readModeState() as unknown as { sessions: Record<string, { lastSmartDecision?: { escalated?: boolean } }> };
  assert.equal(gatewayDoc.sessions[sessionId]?.lastSmartDecision?.escalated, true);

  // External tool must be ignored because remote recognizeExternalWebTools=false synced onto turn
  const extReceipt = await runHook(clientHome, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "mcp__exa__web_search_exa",
    tool_input: { query: "菜价" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  });
  assert.equal(extReceipt.status, 0, extReceipt.stderr);
  assert.equal(storedTurn(clientHome, sessionId).externalSearchCompleted, false);

  // Own tool receipt (even with explicit session_id and without env vars, resolved via remote.json) must credit turn
  const ownReceipt = await runHook(clientHome, "post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    tool_name: "mcp__plugin-web_s__web_search",
    tool_input: { query: "菜价", session_id: sessionId },
    tool_response: { content: [{ type: "text", text: "Query: 菜价 | Results: 3" }] },
  });
  assert.equal(ownReceipt.status, 0, ownReceipt.stderr);
  assert.equal(storedTurn(clientHome, sessionId).webSearchCompleted, true);
  assert.equal(storedTurn(clientHome, sessionId).webSearchSucceeded, true);

  const stop = await runHook(clientHome, "stop-turn-gate.mjs", { session_id: sessionId });
  assert.equal(stop.status, 0, stop.stderr);
});

test("remote gateway manifest env fallback and legacy 404 fallback work for Smart mode and failOpen=false", async (t) => {
  // 1. Remote gateway with failOpen=false and failing classifier -> escalates via evaluate-turn,
  //    configured via plugin manifest mcpServers.s.env (Windows Desktop compatibility).
  const brokenClassifier = await mockClassifier(t, { status: 500 });
  const gwHome = temporaryHome(t);
  const gwDir = path.join(gwHome, "web-tools");
  writeJson(path.join(gwDir, "config.json"), {
    enabled: true,
    defaultProvider: "exa",
    smartSearch: {
      enabled: true,
      provider: "typesafe",
      model: "jev-latest",
      baseUrl: brokenClassifier.baseUrl,
      timeoutMs: 1000,
      threshold: 0.5,
      failOpen: false,
    },
  });
  writeJson(path.join(gwDir, "credentials.json"), {
    WEB_TOOLS_EXA: "exa-key",
    WEB_TOOLS_TYPESAFE: "jev-key",
  });
  new LocalStorage(gwDir).setSessionMode("global", "smart");
  const handle = await startGatewayServer({ host: "127.0.0.1", port: 0, baseDir: gwDir, password: "pw" });
  t.after(() => handle.close());

  const fakePluginRoot = temporaryHome(t);
  writeJson(path.join(fakePluginRoot, "kimi.plugin.json"), {
    name: "web",
    mcpServers: {
      s: {
        command: "node",
        args: ["./bin/mcp-server.mjs"],
        env: {
          KIMI_WEB_TOOLS_GATEWAY_URL: handle.url,
          KIMI_WEB_TOOLS_GATEWAY_TOKEN: "pw",
        },
      },
    },
  });
  const clientHome = temporaryHome(t);
  const res = await runHook(
    clientHome,
    "user-prompt-submit.mjs",
    { session_id: "manifest-s1", prompt: "今天菜价多少" },
    { KIMI_PLUGIN_ROOT: fakePluginRoot },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[Smart Mode: Escalated to Required Web Search\]/);
  assert.equal(storedTurn(clientHome, "manifest-s1").required, true);

  // 2. Legacy remote gateway returning 404 on /web-tools/mcp/evaluate-turn falls back to /status + /smart-classifier/test
  const hits: string[] = [];
  const legacyServer = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    hits.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/web-tools/mcp/evaluate-turn") {
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: { code: "not-found", message: "Unknown MCP endpoint: evaluate-turn" } }));
      return;
    }
    if (req.url === "/web-tools/mcp/status") {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        value: {
          usable: ["exa"],
          mode: { sessionId: "legacy-s1", mode: "smart", globalMode: "smart", available: true },
          config: { enabled: true, exemptWhenNoProvider: true, recognizeExternalWebTools: true, requiredEvidence: "search" },
        },
      }));
      return;
    }
    if (req.url === "/web-tools/api/smart-classifier/test") {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        value: { ok: true, escalated: true, provider: "typesafe", model: "jev-latest", latencyMs: 50, threshold: 0.5 },
      }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => legacyServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => legacyServer.close(() => resolve())));
  const addr = legacyServer.address();
  assert.ok(addr && typeof addr !== "string");

  const legacyClientHome = temporaryHome(t);
  const legacyRes = await runHook(
    legacyClientHome,
    "user-prompt-submit.mjs",
    { session_id: "legacy-s1", prompt: "今天菜价多少？" },
    { KIMI_WEB_TOOLS_GATEWAY_URL: `http://127.0.0.1:${addr.port}` },
  );
  assert.equal(legacyRes.status, 0, legacyRes.stderr);
  assert.deepEqual(hits, ["/web-tools/mcp/evaluate-turn", "/web-tools/mcp/status", "/web-tools/api/smart-classifier/test"]);
  assert.match(legacyRes.stdout, /\[Smart Mode: Escalated to Required Web Search\]/);
  assert.equal(storedTurn(legacyClientHome, "legacy-s1").required, true);
});

test("Windows BOM remote.json, syncMode=false, sendContext=false, legacy failOpen=false, and recordSmartDecision cap", async (t) => {
  // 1. BOM remote.json + syncMode=false + sendContext=false against a shared gateway
  const classifier = await mockClassifier(t, {
    probabilities: { needs_external_lookup: 0.92, involves_tool_or_config_claim: 0.05 },
  });
  const gwHome = temporaryHome(t);
  const gwDir = path.join(gwHome, "web-tools");
  writeJson(path.join(gwDir, "config.json"), {
    enabled: true,
    defaultProvider: "exa",
    smartSearch: {
      enabled: true,
      provider: "typesafe",
      model: "jev-latest",
      baseUrl: classifier.baseUrl,
      timeoutMs: 2000,
      threshold: 0.5,
      failOpen: true,
      enableTranscriptContext: true,
    },
  });
  writeJson(path.join(gwDir, "credentials.json"), {
    WEB_TOOLS_EXA: "exa-key",
    WEB_TOOLS_TYPESAFE: "jev-key",
  });
  // Owner gateway is in "auto" mode; guest keeps local "smart" mode with syncMode=false & sendContext=false
  const gwStorage = new LocalStorage(gwDir);
  gwStorage.setSessionMode("global", "auto");
  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir: gwDir,
    password: "owner-password",
    clientTokens: ["guest-shared-token"],
  });
  t.after(() => handle.close());

  const guestHome = temporaryHome(t);
  fs.mkdirSync(path.join(guestHome, "web-tools"), { recursive: true });
  // Write UTF-8 BOM (as Windows PowerShell 5.1 does by default)
  fs.writeFileSync(
    path.join(guestHome, "web-tools", "remote.json"),
    `\uFEFF${JSON.stringify({ url: handle.url, token: "guest-shared-token", syncMode: false, sendContext: false })}\n`,
    "utf8",
  );
  new LocalStorage(path.join(guestHome, "web-tools")).setSessionMode("global", "smart");
  writeWire(guestHome, "guest-priv-s1");

  const guestRes = await runHook(guestHome, "user-prompt-submit.mjs", {
    session_id: "guest-priv-s1",
    prompt: "真的吗",
  });
  assert.equal(guestRes.status, 0, guestRes.stderr);
  assert.match(guestRes.stdout, /\[Smart Mode: Escalated to Required Web Search\]/);
  // Guest local mode stays "smart" (not overwritten by gateway's "auto")
  assert.equal(new LocalStorage(path.join(guestHome, "web-tools")).readModeState().globalMode, "smart");
  // sendContext=false ensures client wire.jsonl transcript context was NOT sent to shared gateway
  assert.equal(classifier.requests.length, 1);
  const sentState = classifier.requests[0].body.state as Record<string, unknown>;
  assert.equal(sentState.recent_user_context, undefined);
  assert.equal(sentState.last_assistant_reply, undefined);
  // Guest evaluation must not pollute owner's mode-state.json
  assert.equal(Object.hasOwn(gwStorage.readModeState().sessions, "guest-priv-s1"), false);

  // 2. Legacy 404 fallback honors failOpen=false even when /smart-classifier/test returns HTTP 200 { ok: false, escalated: false }
  const legacyFailServer = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    res.setHeader("content-type", "application/json");
    if (req.url === "/web-tools/mcp/evaluate-turn") {
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: { code: "not-found" } }));
      return;
    }
    if (req.url === "/web-tools/mcp/status") {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        value: {
          usable: ["exa"],
          mode: { sessionId: "legacy-fc", mode: "smart", globalMode: "smart", available: true },
          config: { enabled: true, smartSearch: { failOpen: false } },
        },
      }));
      return;
    }
    if (req.url === "/web-tools/api/smart-classifier/test") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, value: { ok: false, escalated: false, error: "Smart classifier test failed" } }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => legacyFailServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => legacyFailServer.close(() => resolve())));
  const failAddr = legacyFailServer.address();
  assert.ok(failAddr && typeof failAddr !== "string");

  const fcHome = temporaryHome(t);
  const fcRes = await runHook(
    fcHome,
    "user-prompt-submit.mjs",
    { session_id: "legacy-fc", prompt: "test fail closed" },
    { KIMI_WEB_TOOLS_GATEWAY_URL: `http://127.0.0.1:${failAddr.port}` },
  );
  assert.equal(fcRes.status, 0, fcRes.stderr);
  assert.equal(storedTurn(fcHome, "legacy-fc").required, true, "legacy 404 fallback must honor failOpen=false");

  // 3. recordSmartDecision caps ephemeral sessions and rejects unsafe prototype keys
  const capDir = path.join(temporaryHome(t), "web-tools");
  const capStorage = new LocalStorage(capDir);
  capStorage.setSessionMode("keep-override", "required");
  // Pre-seed 505 ephemeral sessions directly, then record one new decision to trigger pruning
  const preDoc = capStorage.readModeState();
  for (let i = 0; i < 505; i++) {
    preDoc.sessions[`ephemeral-${i}`] = { updatedAt: 1_000_000 + i };
  }
  capStorage.writeModeState(preDoc);
  capStorage.recordSmartDecision("fresh-session", { escalated: true });
  capStorage.recordSmartDecision("__proto__", { escalated: false });
  const afterDoc = capStorage.readModeState();
  assert.equal(Object.hasOwn(afterDoc.sessions, "keep-override"), true, "explicit mode override must be preserved");
  assert.equal(Object.hasOwn(afterDoc.sessions, "fresh-session"), true);
  assert.ok(Object.keys(afterDoc.sessions).length <= 503, `ephemeral sessions must stay bounded, got ${Object.keys(afterDoc.sessions).length}`);
});


test("syncMode=false honors remote policy, gateway-off exemption, and strips long-prompt transcript context", async (t) => {
  const requests: CapturedRequest[] = [];
  const remote = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    requests.push({ url: req.url ?? "", headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    if (body.promptText === "offline") {
      res.end(JSON.stringify({ ok: true, value: {
        mode: "off", globalMode: "off", exempted: true, readyProviders: [],
        requiredEvidence: "search", recognizeExternalWebTools: true,
      } }));
      return;
    }
    res.end(JSON.stringify({ ok: true, value: {
      mode: "auto", globalMode: "auto", exempted: false, readyProviders: ["exa"],
      requiredEvidence: "search-or-fetch", recognizeExternalWebTools: true,
      ...(body.modeHint === "smart" ? { decision: { ok: true, escalated: true } } : {}),
    } }));
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => remote.close(() => resolve())));
  const port = (remote.address() as { port: number }).port;

  const home = temporaryHome(t);
  const storage = new LocalStorage(path.join(home, "web-tools"));
  fs.mkdirSync(path.join(home, "web-tools"), { recursive: true });
  fs.writeFileSync(path.join(home, "web-tools", "remote.json"), JSON.stringify({
    url: `http://127.0.0.1:${port}`, syncMode: false,
  }));
  storage.setSessionMode("global", "required");
  writeWireEntries(home, "independent-required", [
    { type: "turn.prompt", input: "What did the previous official release change?" },
    { type: "context.append_message", message: { role: "assistant", content: "The previous release updated routing." } },
    { type: "turn.prompt", input: "search the current official documentation" },
  ]);
  const required = await runHook(home, "user-prompt-submit.mjs", {
    session_id: "independent-required", prompt: "search the current official documentation",
  });
  assert.equal(required.status, 0, required.stderr);
  assert.match(required.stdout, /page read/);
  assert.match(required.stdout, /exa/);
  assert.match(required.stdout, /Recognized external web tools/);
  assert.equal(requests[0].body.modeHint, "required");
  const requiredContext = requests[0].body.sessionContext as Record<string, unknown>;
  assert.deepEqual(requiredContext, {}, "independent required turns must not read or send transcript context");
  assert.equal(storedTurn(home, "independent-required").requiredEvidence, "search-or-fetch");
  assert.equal(storedTurn(home, "independent-required").exempted, false);
  assert.equal(storage.readModeState().globalMode, "required");

  const offline = await runHook(home, "user-prompt-submit.mjs", {
    session_id: "independent-required", prompt: "offline",
  });
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /No usable route/);
  assert.doesNotMatch(offline.stdout, /Web Search is required/);
  assert.equal(storedTurn(home, "independent-required").exempted, true);

  const exemptedRequests = requests.length;
  const steerFrozen = await runHook(home, "user-prompt-submit.mjs", {
    session_id: "independent-required", prompt: "offline", is_steer: true,
  });
  assert.equal(steerFrozen.status, 0, steerFrozen.stderr);
  assert.equal(requests.length, exemptedRequests, "steer must reuse the frozen turn rather than reclassify");
  assert.match(steerFrozen.stdout, /No usable route/);

  storage.setSessionMode("global", "smart");
  writeWireEntries(home, "orphan-steer", [
    { type: "turn.prompt", input: "What did the earlier documentation say?" },
    { type: "context.append_message", message: { role: "assistant", content: "I will compare it with current sources." } },
    { type: "turn.prompt", input: "new smart turn without frozen state" },
  ]);
  const orphanSteer = await runHook(home, "user-prompt-submit.mjs", {
    session_id: "orphan-steer", prompt: "new smart turn without frozen state", is_steer: true,
  });
  assert.equal(orphanSteer.status, 0, orphanSteer.stderr);
  const orphanRequest = requests.at(-1)!.body;
  const orphanContext = orphanRequest.sessionContext as Record<string, unknown>;
  assert.equal(orphanContext.prevUserText, undefined, "a long new prompt must not reveal the previous user message");
  assert.equal(typeof orphanContext.lastAssistantReply, "string");
  assert.equal(orphanRequest.isSteer, false, "a missing existing turn is still a new turn requiring classification");
  assert.equal(orphanRequest.modeHint, "smart");
  assert.match(orphanSteer.stdout, /\[Smart Mode: Escalated to Required Web Search\]/);
});

test("legacy remote classifier network failure honors failOpen=false", async (t) => {
  const remote = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    res.setHeader("content-type", "application/json");
    if (req.url === "/web-tools/mcp/evaluate-turn") {
      res.writeHead(404).end(JSON.stringify({ ok: false }));
      return;
    }
    if (req.url === "/web-tools/mcp/status") {
      res.writeHead(200).end(JSON.stringify({ ok: true, value: {
        usable: ["exa"],
        mode: { mode: "smart", globalMode: "smart" },
        config: { enabled: true, smartSearch: { failOpen: false } },
      } }));
      return;
    }
    if (body.prompt === "classifier disabled") {
      res.writeHead(200).end(JSON.stringify({ ok: true, value: { ok: false, escalated: false, fallbackReason: "disabled" } }));
      return;
    }
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => remote.close(() => resolve())));
  const port = (remote.address() as { port: number }).port;
  const env = { KIMI_WEB_TOOLS_GATEWAY_URL: `http://127.0.0.1:${port}` };
  const home = temporaryHome(t);
  const result = await runHook(home, "user-prompt-submit.mjs", {
    session_id: "legacy-network-failure", prompt: "latest official status",
  }, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(storedTurn(home, "legacy-network-failure").required, true);
  assert.equal(storedTurn(home, "legacy-network-failure").exempted, false);
  assert.match(result.stdout, /\[Smart Mode: Escalated to Required Web Search\]/);

  const disabledHome = temporaryHome(t);
  const disabled = await runHook(disabledHome, "user-prompt-submit.mjs", {
    session_id: "legacy-disabled", prompt: "classifier disabled",
  }, env);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(storedTurn(disabledHome, "legacy-disabled").required, false, "an explicitly disabled classifier is not a fail-closed outage");
  assert.doesNotMatch(disabled.stdout, /Escalated to Required/);
});


test("smart classifier state bounds recent tool context", () => {
  const state = buildSmartClassifierState("latest release", false, {
    recentTools: ["", ...Array.from({ length: 9 }, (_, index) => ` web_search:${"x".repeat(150)}-${index} `)],
  }) as { recent_tools: string[] };
  assert.equal(state.recent_tools.length, 6);
  assert.ok(state.recent_tools.every((tool) => tool.length <= 120));
  assert.ok(state.recent_tools.every((tool) => tool.trim().length > 0));
});


test("empty prompts never send transcript context to the remote gateway", async (t) => {
  const requests: CapturedRequest[] = [];
  const remote = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: {
      mode: "smart", globalMode: "smart", exempted: false, readyProviders: ["exa"],
      requiredEvidence: "search", recognizeExternalWebTools: true,
      decision: { ok: true, escalated: false },
    } }));
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => remote.close(() => resolve())));
  const port = (remote.address() as { port: number }).port;
  const home = temporaryHome(t);
  writeWire(home, "empty-prompt-session");
  const res = await runHook(home, "user-prompt-submit.mjs", {
    session_id: "empty-prompt-session", prompt: "   ",
  }, { KIMI_WEB_TOOLS_GATEWAY_URL: `http://127.0.0.1:${port}` });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(requests.length, 1, "syncMode still evaluates the turn remotely");
  assert.deepEqual(requests[0].body.sessionContext, {}, "empty prompt must not read or send transcript context");
});
