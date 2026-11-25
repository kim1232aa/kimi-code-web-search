import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalStorage } from "../src/host/local-storage.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ownSearch = "mcp__plugin-web_s__web_search";

function fixture(t: any) {
  const parent = path.join(root, "temp", "required-mode-tests");
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, "case-"));
  const storage = new LocalStorage(path.join(home, "web-tools"));
  storage.ensureDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hook = (file: string, payload: object) => spawnSync(process.execPath, [path.join(root, "hooks", file)], {
    input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, KIMI_CODE_HOME: home },
  });
  return { home, storage, hook };
}

test("required prompt tells the model any search channel satisfies the turn", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  const result = hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Any web search counts/);
  assert.match(result.stdout, /built-in `WebSearch`/);
});

test("pre-tool does not count a call as completed and never blocks on a stale binding", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  const pre = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch, tool_call_id: "call-a",
    tool_input: { query: "example", session_id: "session-a", turn_id: storage.getTurnState("session-a")!.turn },
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, false);
  const stop = hook("stop-turn-gate.mjs", { session_id: "session-a" });
  assert.equal(stop.status, 2);
  const staleSession = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch,
    tool_input: { session_id: "session-b" },
  });
  assert.equal(staleSession.status, 0, "a mismatched binding is advisory, not a denial");
});

test("a mid-turn mode switch takes effect next turn; off blocks tools immediately", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "auto");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  storage.setSessionMode("global", "required");
  // The requirement is frozen at turn start: a mid-turn switch to required is
  // not enforced for the current turn.
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 0);
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  storage.setSessionMode("global", "off");
  // off blocks this plugin's web tools immediately (pre-tool gate)...
  assert.equal(hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name: ownSearch }).status, 2);
  // ...but does not release the current turn's frozen Stop requirement.
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 2);
  storage.setSessionMode("global", "auto");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 0);
});

test("auto mode allows the binding to be omitted or mismatched without denial", (t) => {
  const { storage, hook } = fixture(t);
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  const ordinary = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch, tool_input: { query: "example" },
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const mismatched = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch, tool_input: { query: "example", session_id: "session-b" },
  });
  assert.equal(mismatched.status, 0, "a stale binding never blocks a search");
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, false);
});

test("other MCP tools neither satisfy required mode nor get blocked by off mode", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "off");
  for (const tool_name of ["FetchURL", "mcp__9router__search", "mcp__agy-search__search_web", "mcp__tavily__tavily_search"]) {
    assert.equal(hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name }).status, 0);
  }
  assert.equal(storage.getTurnState("session-a"), undefined);
});

test("actual completed calls satisfy only their own turn; every next round resets", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  const first = storage.getTurnState("session-a")!;
  assert.equal(typeof (storage as any).completeTool, "function");
  (storage as any).completeTool("session-a", "web_search", true, first.turn);
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 0);
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.notEqual(storage.getTurnState("session-a")!.turn, first.turn);
  (storage as any).completeTool("session-a", "web_search", true, first.turn);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, false);
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 2);
  const second = storage.getTurnState("session-a")!;
  (storage as any).completeTool("session-a", "web_search", false, second.turn);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, true);
  assert.equal(storage.getTurnState("session-a")!.webSearchSucceeded, false);
  const failed = hook("stop-turn-gate.mjs", { session_id: "session-a" });
  assert.equal(failed.status, 0);
  assert.match(failed.stdout, /fail|未验证/i);
});

test("simultaneous sessions keep separate turn state", async (t) => {
  const { home, storage } = fixture(t);
  storage.setSessionMode("global", "required");
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
      env: { ...process.env, KIMI_CODE_HOME: home }, stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
    child.stdin.end(JSON.stringify({ session_id: `parallel-${index}` }));
  })));
  for (let index = 0; index < 8; index++) assert.ok(storage.getTurnState(`parallel-${index}`));
});

test("corrupt mode state fails visibly instead of pretending auto mode", (t) => {
  const { storage, hook } = fixture(t);
  fs.writeFileSync(storage.modeStatePath, "{broken");
  const result = hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.equal(result.status, 1, "hookFailure must exit 1 (fail-open), reserving exit 2 for explicit blocks");
  assert.match(result.stderr, /mode-state|JSON|parse/i);
  assert.equal(fs.readFileSync(storage.modeStatePath, "utf8"), "{broken");
});

test("hookPayload decodes multi-byte UTF-8 split across stdin chunks", async (t) => {
  const { home, storage } = fixture(t);
  storage.setSessionMode("global", "required");
  const payloadBytes = Buffer.from(JSON.stringify({ session_id: "utf8-split", prompt: "你好世界🚀" }), "utf8");
  const splitAt = payloadBytes.indexOf(0xe4) + 1;
  assert.ok(splitAt > 1, "test payload must contain multi-byte UTF-8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
      env: { ...process.env, KIMI_CODE_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`))));
    child.stdin.write(payloadBytes.subarray(0, splitAt));
    setTimeout(() => child.stdin.end(payloadBytes.subarray(splitAt)), 20);
  });
  assert.ok(storage.getTurnState("utf8-split"), "chunked multi-byte payload must parse cleanly");
});

test("updateModeState retries transient NTFS errors on lock ops and atomic rename", (t) => {
  const { home } = fixture(t);
  const statePath = path.join(home, "web-tools", "mode-state.json");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import assert from "node:assert/strict";
    import { updateModeState, readModeState } from "./hooks/mode-state.mjs";

    const origOpen = fs.openSync;
    const origStat = fs.statSync;
    const origRead = fs.readFileSync;
    const origRename = fs.renameSync;
    let openFails = 0;
    let statFails = 0;
    let renameFails = 0;
    const lockPath = ${JSON.stringify(statePath + ".lock")};
    const filePath = ${JSON.stringify(statePath)};

    fs.openSync = (p, flags, ...rest) => {
      if (p === lockPath && flags === "wx") {
        if (openFails === 0) { openFails++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
        if (openFails === 1) { openFails++; throw Object.assign(new Error("exists"), { code: "EEXIST" }); }
      }
      return origOpen(p, flags, ...rest);
    };
    fs.statSync = (p, ...rest) => {
      if (p === lockPath && statFails === 0) { statFails++; throw Object.assign(new Error("perm"), { code: "EPERM" }); }
      if (p === lockPath) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return origStat(p, ...rest);
    };
    fs.readFileSync = (p, ...rest) => origRead(p, ...rest);
    fs.renameSync = (from, to) => {
      if (to === filePath && renameFails < 2) {
        renameFails++;
        throw Object.assign(new Error("access"), { code: renameFails === 1 ? "EACCES" : "EPERM" });
      }
      return origRename(from, to);
    };

    updateModeState(filePath, (doc) => { doc.globalMode = "required"; });
    assert.equal(openFails, 2);
    assert.equal(statFails, 1);
    assert.equal(renameFails, 2);
    assert.equal(readModeState(filePath).globalMode, "required");
  `], { cwd: root, env: { ...process.env, KIMI_CODE_HOME: home }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("post-tool-receipt credits own tools for remote gateway or omitted/global session_id unless subagent active locally", (t) => {
  const { home, storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  const runWithEnv = (file: string, payload: object, extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(root, "hooks", file)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, KIMI_CODE_HOME: home, ...extraEnv },
    });

  // 1. Local gateway with explicit non-global session_id -> receipt skips (gateway is authoritative)
  hook("user-prompt-submit.mjs", { session_id: "s-explicit" });
  assert.equal(hook("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-explicit",
    tool_name: ownSearch,
    tool_input: { query: "q", session_id: "s-explicit" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  }).status, 0);
  assert.equal(storage.getTurnState("s-explicit")!.webSearchCompleted, false);

  // 2. Local gateway with omitted session_id or "global" -> receipt credits turn
  assert.equal(hook("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-explicit",
    tool_name: ownSearch,
    tool_input: { query: "q" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  }).status, 0);
  assert.equal(storage.getTurnState("s-explicit")!.webSearchCompleted, true);
  assert.equal(storage.getTurnState("s-explicit")!.webSearchSucceeded, true);

  hook("user-prompt-submit.mjs", { session_id: "s-global-arg" });
  assert.equal(hook("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-global-arg",
    tool_name: ownSearch,
    tool_input: { query: "q", session_id: "global" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  }).status, 0);
  assert.equal(storage.getTurnState("s-global-arg")!.webSearchCompleted, true);
  assert.equal(storage.getTurnState("s-global-arg")!.webSearchSucceeded, true);

  // 3. Local gateway with active subagent -> omitted session_id skips crediting parent turn
  hook("user-prompt-submit.mjs", { session_id: "s-sub" });
  hook("subagent-activity.mjs", { hook_event_name: "SubagentStart", session_id: "s-sub" });
  assert.equal(hook("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-sub",
    tool_name: ownSearch,
    tool_input: { query: "q" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  }).status, 0);
  assert.equal(storage.getTurnState("s-sub")!.webSearchCompleted, false);

  // 4. Remote gateway -> credits even with explicit session_id (and even when config disables external recognition)
  fs.writeFileSync(path.join(home, "web-tools", "config.json"), JSON.stringify({ recognizeExternalWebTools: false }));
  hook("user-prompt-submit.mjs", { session_id: "s-remote" });
  assert.equal(runWithEnv("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-remote",
    tool_name: "mcp__plugin-web_s__web_fetch",
    tool_input: { url: "https://example.org", sessionId: "s-remote" },
    tool_response: { content: [{ type: "text", text: "Error: HTTP 502" }] },
  }, { KIMI_WEB_TOOLS_GATEWAY_URL: "https://gw.example.com" }).status, 0);
  assert.equal(storage.getTurnState("s-remote")!.webFetchCompleted, true);
  assert.equal(storage.getTurnState("s-remote")!.webFetchSucceeded, false);

  assert.equal(runWithEnv("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-remote",
    tool_name: ownSearch,
    tool_input: { query: "q", session_id: "s-remote" },
    tool_response: "Error: timeout",
  }, { KIMI_WEB_TOOLS_GATEWAY_URL: "https://gw.example.com" }).status, 0);
  assert.equal(storage.getTurnState("s-remote")!.webSearchCompleted, true);
  assert.equal(storage.getTurnState("s-remote")!.webSearchSucceeded, false);

  // 5. Remote gateway with active subagent -> unbound call must NOT credit parent turn; explicit parent session_id DOES
  hook("user-prompt-submit.mjs", { session_id: "s-remote-sub" });
  hook("subagent-activity.mjs", { hook_event_name: "SubagentStart", session_id: "s-remote-sub" });
  assert.equal(runWithEnv("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-remote-sub",
    tool_name: ownSearch,
    tool_input: { query: "unbound subagent query" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  }, { KIMI_WEB_TOOLS_GATEWAY_URL: "https://gw.example.com" }).status, 0);
  assert.equal(storage.getTurnState("s-remote-sub")!.webSearchCompleted, false, "unbound subagent search must not credit parent in remote mode");

  assert.equal(runWithEnv("post-tool-receipt.mjs", {
    hook_event_name: "PostToolUse",
    session_id: "s-remote-sub",
    tool_name: ownSearch,
    tool_input: { query: "bound subagent query", session_id: "s-remote-sub" },
    tool_response: { content: [{ type: "text", text: "ok" }] },
  }, { KIMI_WEB_TOOLS_GATEWAY_URL: "https://gw.example.com" }).status, 0);
  assert.equal(storage.getTurnState("s-remote-sub")!.webSearchCompleted, true, "explicitly bound subagent search must credit parent in remote mode");
});

test("stop-turn-gate fallback turn demands search and distinguishes no-attempt vs all-failed reminders", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");

  // Missing turn record falls back to search-only requirement
  const firstStop = hook("stop-turn-gate.mjs", { session_id: "no-turn-yet" });
  assert.equal(firstStop.status, 2);
  assert.match(firstStop.stderr, /Run any web search before finalizing/);
  assert.doesNotMatch(firstStop.stderr, /or page read/);

  // No search attempted reminder
  hook("user-prompt-submit.mjs", { session_id: "s-none" });
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "s-none" }).status, 2);
  const noneFinal = hook("stop-turn-gate.mjs", { session_id: "s-none" });
  assert.equal(noneFinal.status, 0);
  assert.match(noneFinal.stdout, /not completed.*未验证/);
  assert.doesNotMatch(noneFinal.stdout, /Web research failed/);

  // All attempts failed reminder
  hook("user-prompt-submit.mjs", { session_id: "s-fail" });
  (storage as any).completeTool("s-fail", "web_search", false, 1);
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "s-fail" }).status, 2);
  const failFinal = hook("stop-turn-gate.mjs", { session_id: "s-fail" });
  assert.equal(failFinal.status, 0);
  assert.match(failFinal.stdout, /Web research failed.*未验证/);
});

test("kimi.plugin.json updated timeout, clean metadata, and robust PostToolUse matchers", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "kimi.plugin.json"), "utf8"));
  assert.doesNotMatch(manifest.description, /xiaohongshu|\bX\b/i);
  assert.ok(!manifest.keywords.includes("xiaohongshu"));
  assert.ok(!manifest.keywords.includes("x"));
  const promptHook = manifest.hooks.find((h: any) => h.event === "UserPromptSubmit");
  assert.equal(promptHook.timeout, 15);

  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    const matcher = manifest.hooks.find((h: any) => h.event === event).matcher;
    const re = new RegExp(matcher);
    for (const tool of ["mcp__ddg__search", "DDG_SEARCH", "DdgSearch", "mcp__perplexity__perplexity_ask", "mcp__perplexity__perplexityAsk", "mcp__custom__research", "mcp__custom__reason", "WEB_SEARCH", "FETCH_URL"]) {
      assert.ok(re.test(tool), `${event} must match ${tool}`);
    }
    for (const local of ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoList", "TaskList", "TaskOutput", "NotifyUser", "Skill", "Agent", "CronCreate", "WaitFor"]) {
      assert.ok(!re.test(local), `${event} must skip ${local}`);
    }
  }
});


test("BOM mode/config files parse and remote receipts reject explicit cross-session ids", (t) => {
  const { home, storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  const modePath = path.join(home, "web-tools", "mode-state.json");
  fs.writeFileSync(modePath, `\uFEFF${fs.readFileSync(modePath, "utf8")}`, "utf8");
  fs.writeFileSync(path.join(home, "web-tools", "config.json"), "\uFEFF{\"recognizeExternalWebTools\":true,\"exemptWhenNoProvider\":false}", "utf8");

  const turn = hook("user-prompt-submit.mjs", { session_id: "s-bom-receipt" });
  assert.equal(turn.status, 0, turn.stderr);
  assert.equal(storage.getTurnState("s-bom-receipt")?.required, true, "BOM mode-state must still enforce required");

  const environment = { ...process.env, KIMI_CODE_HOME: home };
  const external = spawnSync(process.execPath, [path.join(root, "hooks", "post-tool-receipt.mjs")], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", session_id: "s-bom-receipt",
      tool_name: "mcp__exa__web_search_exa", tool_input: { query: "q" },
      tool_response: { content: [{ type: "text", text: "ok" }] },
    }),
    encoding: "utf8", env: environment,
  });
  assert.equal(external.status, 0, external.stderr);
  assert.equal(storage.getTurnState("s-bom-receipt")?.externalSearchCompleted, true, "BOM config must still enable external recognition");

  const mismatched = spawnSync(process.execPath, [path.join(root, "hooks", "post-tool-receipt.mjs")], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", session_id: "s-bom-receipt",
      tool_name: ownSearch, tool_input: { query: "q", session_id: "another-session" },
      tool_response: { content: [{ type: "text", text: "ok" }] },
    }),
    encoding: "utf8", env: { ...environment, KIMI_WEB_TOOLS_GATEWAY_URL: "https://gw.example.com" },
  });
  assert.equal(mismatched.status, 0, mismatched.stderr);
  assert.equal(storage.getTurnState("s-bom-receipt")?.webSearchCompleted, false, "explicit other-session tool calls never credit this session");
});
