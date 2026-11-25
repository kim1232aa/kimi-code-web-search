import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startGatewayServer } from "../src/host/gateway-server.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t: any) {
  const parent = path.join(root, "temp", "mcp-lifecycle");
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function runNode(args: string[], env: NodeJS.ProcessEnv, input = "") {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  child.stdin.write(input);
  setTimeout(() => child.stdin.end(), input.includes('"method":"initialize"') ? 300 : 0);
  try {
    const [code] = await once(child, "close");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayFixture(t: any, slowVersion = false) {
  const home = fixture(t);
  const requests: { url: string; method: string; body: any }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, method: req.method!, body: body ? JSON.parse(body) : undefined });
    if (slowVersion && req.url === "/web-tools/api/version/check") {
      await new Promise(resolve => setTimeout(resolve, 1800));
    }
    res.setHeader("content-type", "application/json");
    const value = req.url === "/health"
      ? { status: "healthy", version: "0.4.0", pid: process.pid, available: true }
      : req.url === "/web-tools/api/version/check"
        ? { currentVersion: "0.4.0" }
        : { query: "fixture", sources: [], body: { content: "x".repeat(1024 * 1024) }, url: "https://example.com", statusCode: 200 };
    res.end(JSON.stringify({ ok: true, value }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as any).port;
  return { home, requests, env: { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_PORT: String(port) } };
}

const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

test("daemon status probes local health without waiting for release lookup", async (t) => {
  const { env, requests } = await gatewayFixture(t, true);
  const result = await runNode(["bin/gateway-daemon.mjs", "status"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).running, true);
  assert.deepEqual(requests.map(r => [r.method, r.url]), [["GET", "/health"]]);
});

test("MCP handshake does not launch a daemon before any tool is called", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], env, rpc(1, "initialize") + rpc(2, "tools/list"));
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, 2);
  for (const tool of replies.find(reply => reply.id === 2).result.tools) {
    if (!["web_search", "web_fetch"].includes(tool.name)) continue;
    assert.ok(tool.inputSchema.properties.turn_id.type.includes("string"));
    assert.ok(tool.inputSchema.properties.turn_id.type.includes("integer"));
  }
  assert.equal(requests.length, 0);
});

test("MCP accepts bounded decimal strings and forwards numeric arguments", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], env,
    rpc(1, "tools/call", { name: "web_search", arguments: { query: "fixture", max_results: "2", session_id: "session-a", turn_id: "7" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(JSON.parse(result.stdout).result.isError, true, result.stdout);
  assert.deepEqual(requests.find(r => r.url.endsWith("/search"))?.body,
    { query: "fixture", maxResults: 2, sessionId: "session-a", turnId: 7 });
});

test("a configured gateway URL is used instead of starting a local gateway", async (t) => {
  const home = fixture(t);
  const requests: { url: string; authorization: string | undefined; body: any }[] = [];
  const remote = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, value: { query: "fixture", sources: [] } }));
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(async () => { remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); });
  const port = (remote.address() as any).port;

  const env = {
    ...process.env,
    KIMI_CODE_HOME: home,
    KIMI_WEB_TOOLS_GATEWAY_URL: `http://127.0.0.1:${port}`,
    KIMI_WEB_TOOLS_GATEWAY_TOKEN: "remote-token",
  };
  const result = await runNode(["bin/mcp-server.mjs"], env,
    rpc(1, "tools/call", { name: "web_search", arguments: { query: "fixture" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(JSON.parse(result.stdout).result.isError, true, result.stdout);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/web-tools/mcp/search");
  assert.equal(requests[0].authorization, "Bearer remote-token");
  assert.equal(fs.existsSync(path.join(home, "web-tools", "gateway.json")), false, "no local gateway is started");
});

test("read-only MCP queries do not launch a stopped local gateway", async (t) => {
  const home = fixture(t);
  const server = http.createServer((_, res) => res.writeHead(503).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const env = {
    ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_HOST: "127.0.0.1",
    KIMI_WEB_TOOLS_PORT: String(port), KIMI_WEB_TOOLS_GATEWAY_URL: "",
  };
  const result = await runNode(["bin/mcp-server.mjs"], env,
    rpc(1, "tools/call", { name: "web_status" }) +
    rpc(2, "tools/call", { name: "web_mode", arguments: { action: "get" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(home, "web-tools", "gateway.log")), false, result.stdout);
  for (const reply of result.stdout.trim().split("\n").map(line => JSON.parse(line))) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /local gateway is not running.*KIMI_WEB_TOOLS_GATEWAY_URL/i);
  }
});

test("read-only MCP queries use an already running local gateway", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], { ...env, KIMI_WEB_TOOLS_GATEWAY_URL: "" },
    rpc(1, "tools/call", { name: "web_status" }) + rpc(2, "tools/call", { name: "web_mode" }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").map(line => JSON.parse(line)).some(r => r.result.isError), false);
  assert.ok(requests.some(r => r.url === "/web-tools/mcp/status"));
  assert.ok(requests.some(r => r.url === "/web-tools/mcp/mode"));
});

async function remoteStatus(t: any, value: unknown) {
  const home = fixture(t);
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/web-tools/mcp/status");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, value }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = await runNode(["bin/mcp-server.mjs"], { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_GATEWAY_URL: url },
    rpc(1, "tools/call", { name: "web_status" }));
  assert.equal(result.code, 0, result.stderr);
  return { home, text: JSON.parse(result.stdout).result.content[0].text };
}

test("remote status lists only usable search engines and hides bind/PID", async (t) => {
  const { home, text } = await remoteStatus(t, { usable: ["exa"] });
  assert.equal(text, "Usable search engines: exa");
  assert.doesNotMatch(text, /Dashboard|Gateway bind|PID|18492/i);
  assert.equal(fs.existsSync(path.join(home, "web-tools", "gateway.log")), false);
});

test("stdio status still filters a legacy gateway payload to usable engines", async (t) => {
  const { text } = await remoteStatus(t, {
    gateway: { url: "http://127.0.0.1:18492", pid: 321 },
    providers: [
      { name: "exa", enabled: true, keyConfigured: true },
      { name: "brave", enabled: true, keyConfigured: false },
      { name: "searxng", enabled: true, keyConfigured: false, baseUrlConfigured: false },
      { name: "tavily", enabled: false, keyConfigured: true },
    ],
  });
  assert.equal(text, "Usable search engines: exa");
  assert.doesNotMatch(text, /brave|searxng|tavily|Dashboard|18492|PID/i);
});

test("daemon startup gives build instructions for a source-only install", async (t) => {
  const home = fixture(t);
  const isolated = path.join(home, "plugin");
  fs.mkdirSync(path.join(isolated, "bin"), { recursive: true });
  fs.copyFileSync(path.join(root, "bin/gateway-daemon.mjs"), path.join(isolated, "bin/gateway-daemon.mjs"));
  const server = http.createServer((_, res) => res.writeHead(503).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const result = await runNode([path.join(isolated, "bin/gateway-daemon.mjs"), "ensure"], {
    ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_HOST: "127.0.0.1",
    KIMI_WEB_TOOLS_PORT: String((server.address() as { port: number }).port),
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /missing lib\/host\/gateway-server\.js.*npm ci.*npm run build/);
  assert.equal(fs.existsSync(path.join(home, "web-tools", "gateway.log")), false);
});

test("invalid max_results inputs fail without launching a gateway while advisory turn_id degrades cleanly", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const invalid = ["", " ", "1e1", "0x10", "1.5", "0", "-1", true, [], null, 1.5, 21, 9007199254740992];
  const input = invalid.map((max_results, i) => rpc(i + 1, "tools/call", {
    name: "web_search", arguments: { query: "fixture", max_results },
  })).join("");
  const result = await runNode(["bin/mcp-server.mjs"], env, input);
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, invalid.length);
  for (const reply of replies) assert.equal(reply.result.isError, true, JSON.stringify(reply));
  assert.equal(requests.length, 0);

  const advisory = await runNode(["bin/mcp-server.mjs"], env,
    rpc(101, "tools/call", { name: "web_search", arguments: { query: "fixture", turn_id: null } }) +
    rpc(102, "tools/call", { name: "web_fetch", arguments: { url: "https://example.com", turn_id: -5 } }));
  assert.equal(advisory.code, 0, advisory.stderr);
  const advReplies = advisory.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(advReplies.length, 2);
  for (const reply of advReplies) assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
  assert.equal(requests.find(r => r.url.endsWith("/search"))?.body.turnId, undefined);
  assert.equal(requests.find(r => r.url.endsWith("/fetch"))?.body.turnId, undefined);
});

test("EOF drains a large in-flight MCP response before exiting", async (t) => {
  const { env } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], env,
    rpc(1, "tools/call", { name: "web_fetch", arguments: { url: "https://example.com" } }));
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.notEqual(response.result.isError, true, result.stdout.slice(0, 300));
  assert.ok(response.result.content[0].text.endsWith("x".repeat(1024 * 1024)));
});

test("startup reports a child import failure instead of an eight-second health timeout", async (t) => {
  const home = fixture(t);
  const isolated = path.join(home, "plugin");
  fs.mkdirSync(path.join(isolated, "bin"), { recursive: true });
  fs.mkdirSync(path.join(isolated, "lib", "host"), { recursive: true });
  fs.copyFileSync(path.join(root, "bin/gateway-daemon.mjs"), path.join(isolated, "bin/gateway-daemon.mjs"));
  fs.writeFileSync(path.join(isolated, "lib/host/gateway-server.js"), 'throw new Error("test startup import failure");\n');
  const portServer = http.createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as any).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const started = Date.now();
  const result = await runNode([path.join(isolated, "bin/gateway-daemon.mjs"), "ensure"], {
    ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_PORT: String(port),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited|exit code/i);
  assert.match(result.stderr, /gateway\.log/);
  assert.ok(Date.now() - started < 4000, result.stderr);
});

test("required hook accepts any binding shape and never rejects a search", (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "mode-state.json"), JSON.stringify({ globalMode: "required", sessions: {}, updatedAt: 0 }));
  const hook = (file: string, payload: object) => spawnSync(process.execPath, [path.join(root, "hooks", file)], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: JSON.stringify(payload), encoding: "utf8",
  });
  assert.equal(hook("user-prompt-submit.mjs", { session_id: "session-a" }).status, 0);
  for (const turn_id of [1, "1", undefined, null, 2, "999"]) {
    const pre = hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name: "web_search",
      tool_input: { query: "fixture", session_id: "session-a", turn_id } });
    assert.equal(pre.status, 0, `a stale/absent turn_id must not block the call: ${pre.stderr}`);
  }
  const stop = hook("stop-turn-gate.mjs", { session_id: "session-a" });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /Run any web search/);
});

test("a dead lock owner is reclaimed without losing existing session state", async (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  const statePath = path.join(dir, "mode-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ globalMode: "required", sessions: { existing: { mode: "off" } }, updatedAt: 0 }));
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = owner.pid!;
  await once(owner, "exit");
  fs.writeFileSync(`${statePath}.lock`, String(deadPid));
  const result = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: JSON.stringify({ session_id: "new-session" }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(doc.sessions.existing.mode, "off");
  assert.equal(doc.sessions["new-session"].turn.turn, 1);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
});

test("a live lock is not stolen just because it is old", (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  const lock = path.join(dir, "mode-state.json.lock");
  fs.writeFileSync(lock, String(process.pid));
  fs.utimesSync(lock, new Date(0), new Date(0));
  const result = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: '{"session_id":"session-a"}', encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Timed out/);
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("an unowned empty lock is reclaimed only after the grace period", (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  const statePath = path.join(dir, "mode-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ globalMode: "auto", sessions: {}, updatedAt: 0 }));

  const lock = `${statePath}.lock`;
  fs.writeFileSync(lock, "");
  const fresh = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: '{"session_id":"fresh"}', encoding: "utf8",
  });
  assert.equal(fresh.status, 1, "a fresh empty lock may still be mid-creation");
  assert.match(fresh.stderr, /Timed out/);
  assert.equal(fs.existsSync(lock), true);

  fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const stale = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: '{"session_id":"stale"}', encoding: "utf8",
  });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(fs.existsSync(lock), false, "an old unowned empty lock must be reclaimed");
  const doc = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(doc.sessions["stale"].turn.turn, 1);
});

test("stop refuses to signal an unverified live PID and keeps the state file", async (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir, { recursive: true });
  // gateway.json pointing at a live, unrelated process (this test process):
  // no health endpoint answers this port and its cmdline is not the gateway.
  const gwPath = path.join(dir, "gateway.json");
  fs.writeFileSync(gwPath, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 1 }));
  const result = await runNode(["bin/gateway-daemon.mjs", "stop"], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "unverified");
  assert.equal(fs.existsSync(gwPath), true, "an unverified state file is kept for diagnosis");
  assert.doesNotThrow(() => process.kill(process.pid, 0), "the unrelated process must not have been signaled");
});

test("stop cleans the state file when the recorded PID is already dead", async (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir, { recursive: true });
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = dead.pid!;
  await once(dead, "exit");
  const gwPath = path.join(dir, "gateway.json");
  fs.writeFileSync(gwPath, JSON.stringify({ pid, host: "127.0.0.1", port: 1 }));
  const result = await runNode(["bin/gateway-daemon.mjs", "stop"], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  const res = JSON.parse(result.stdout);
  assert.equal(res.status, "stopped");
  assert.equal(res.pid, pid);
  assert.equal(fs.existsSync(gwPath), false);
});

test("gateway records a retrieval against the session's live turn even without a binding", async (t) => {
  const home = fixture(t);
  const handle = await startGatewayServer({ host: "127.0.0.1", port: 0, baseDir: path.join(home, "web-tools"), projectRoot: root });
  t.after(() => handle.close());
  handle.storage.setCredential("WEB_TOOLS_EXA", "test-exa-key");
  handle.storage.setSessionMode("global", "required");
  const env = { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_PORT: String(handle.port) };
  for (const session_id of ["session-a", "session-b"]) {
    const prompt = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
      env, input: JSON.stringify({ session_id }), encoding: "utf8",
    });
    assert.equal(prompt.status, 0, prompt.stderr);
  }
  // A fetch to a blocked private URL still records the attempt (and the
  // failure) on the caller's turn — a stale or absent binding is not an error.
  const result = await runNode(["bin/mcp-server.mjs"], env, rpc(1, "tools/call", {
    name: "web_fetch", arguments: { url: "http://127.0.0.1/private", session_id: "session-a" },
  }) + rpc(2, "ping"));
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.find(reply => reply.id === 1).result.isError, true);
  assert.deepEqual(replies.find(reply => reply.id === 2).result, {});
  assert.equal(handle.storage.getTurnState("session-a")!.webFetchCompleted, true);
  assert.equal(handle.storage.getTurnState("session-a")!.webFetchSucceeded, false);
  assert.equal(handle.storage.getTurnState("session-b")!.webFetchCompleted, false);
});

test("daemon reports spawn error events without uncaught process errors", async (t) => {
  const home = fixture(t);
  const result = await runNode(["--input-type=module", "-e", `
    import cp from 'node:child_process';
    import { EventEmitter } from 'node:events';
    cp.spawn = () => {
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('error', Object.assign(new Error('test EACCES'), {code:'EACCES'})));
      return child;
    };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    globalThis.fetch = async () => { throw Object.assign(new Error('offline'), {cause:{code:'ECONNREFUSED'}}); };
    const { ensureGatewayDaemon } = await import('./bin/gateway-daemon.mjs');
    try { await ensureGatewayDaemon(); process.exitCode = 2; }
    catch (error) { console.log(error.message); }
  `], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /spawn failed.*EACCES/i);
  assert.doesNotMatch(result.stderr, /Unhandled.*error/);
});

test("daemon does not invoke a non-Node host executable when Node cannot be found", async (t) => {
  const home = fixture(t);
  const result = await runNode(["--input-type=module", "-e", `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    Object.defineProperty(process, 'execPath', {value:'/missing/kimi'});
    fs.existsSync = () => false;
    fs.accessSync = () => { throw Object.assign(new Error('missing'), {code:'ENOENT'}); };
    cp.spawn = () => { throw new Error('must not spawn the host binary'); };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    globalThis.fetch = async () => { throw Object.assign(new Error('offline'), {cause:{code:'ECONNREFUSED'}}); };
    const { ensureGatewayDaemon } = await import('./bin/gateway-daemon.mjs');
    try { await ensureGatewayDaemon(); process.exitCode = 2; }
    catch (error) { console.log(error.message); }
  `], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Node\.js executable not found/);
});

test("MCP server validates JSON-RPC 2.0 requests, cleans tool descriptions, and preserves gateway path prefix", async (t) => {
  const home = fixture(t);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: { query: "q", sources: [], mode: "required", globalMode: "required", available: true } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as any).port;

  const env = { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_GATEWAY_URL: `http://127.0.0.1:${port}/edge/mcp/` };
  const input = [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "123",
    "[]",
    JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_mode", arguments: { action: "get" } } }),
  ].join("\n") + "\n";
  const result = await runNode(["bin/mcp-server.mjs"], env, input);
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, 5, "valid notification must be ignored while invalid/valid requests reply");
  assert.equal(replies[0].error.code, -32600);
  assert.equal(replies[1].error.code, -32600);
  assert.equal(replies[2].id, 1);
  assert.equal(replies[2].error.code, -32600);
  const toolsJson = JSON.stringify(replies[3].result.tools);
  assert.doesNotMatch(toolsJson, /Xiaohongshu|小红书|Twitter|social/i);
  assert.match(replies[4].result.content[0].text, /at least one web_search required per turn/);
  assert.deepEqual(requests, ["/edge/web-tools/mcp/mode"]);

  for (const badUrl of ["http://user:pass@127.0.0.1:8080", "http://127.0.0.1:8080?x=1", "http://127.0.0.1:8080#frag"]) {
    const bad = await runNode(["bin/mcp-server.mjs"], { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_GATEWAY_URL: badUrl },
      rpc(1, "tools/call", { name: "web_status" }));
    const reply = JSON.parse(bad.stdout.trim());
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /KIMI_WEB_TOOLS_GATEWAY_URL/);
  }
});

test("daemon connectHostFor, resolveNodeExecutable directory guard, and LocalStorage error resilience", async (t) => {
  const { connectHostFor } = await import("../bin/gateway-daemon.mjs");
  assert.equal(connectHostFor("0.0.0.0"), "127.0.0.1");
  assert.equal(connectHostFor("::"), "[::1]");
  assert.equal(connectHostFor("::1"), "[::1]");
  assert.equal(connectHostFor("[::1]"), "[::1]");

  // A directory named `node` on PATH must be skipped rather than treated as executable.
  const home = fixture(t);
  const fakeBin = path.join(home, "bin");
  fs.mkdirSync(path.join(fakeBin, process.platform === "win32" ? "node.exe" : "node"), { recursive: true });
  const result = await runNode(["--input-type=module", "-e", `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    Object.defineProperty(process, 'execPath', { value: '/missing/kimi' });
    process.env.PATH = ${JSON.stringify(`"${fakeBin}"`)};
    let spawned;
    cp.spawn = (exe) => { spawned = exe; throw Object.assign(new Error('stop'), { code: 'EACCES' }); };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    globalThis.fetch = async () => { throw Object.assign(new Error('offline'), { cause: { code: 'ECONNREFUSED' } }); };
    const { ensureGatewayDaemon } = await import('./bin/gateway-daemon.mjs');
    try { await ensureGatewayDaemon(); } catch (e) { console.log(JSON.stringify({ spawned, msg: e.message })); }
  `], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout.trim());
  assert.notEqual(info.spawned, path.join(fakeBin, process.platform === "win32" ? "node.exe" : "node"));

  // LocalStorage must not backup/destroy config or credentials on transient EBUSY,
  // and must clean up temp files when renameSync fails.
  const storageDir = path.join(home, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, "config.json"), '{"defaultProvider":"brave"}\n');
  fs.writeFileSync(path.join(storageDir, "credentials.json"), '{"WEB_TOOLS_EXA":"keep"}\n');
  const storageRes = await runNode(["--experimental-strip-types", "--input-type=module", "-e", `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { LocalStorage } from './src/host/local-storage.ts';
    const dir = ${JSON.stringify(storageDir)};
    const storage = new LocalStorage(dir);
    const origRead = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => {
      if (String(p).endsWith('config.json') || String(p).endsWith('credentials.json')) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return origRead(p, ...rest);
    };
    const origRename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('perm'), { code: 'EPERM' }); };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    assert.throws(() => storage.readConfig(), { code: 'EBUSY' });
    assert.throws(() => storage.readAllCredentials(), { code: 'EBUSY' });
    fs.readFileSync = origRead;
    assert.throws(() => storage.writeAllCredentials({ WEB_TOOLS_EXA: 'new' }), { code: 'EPERM' });
    fs.renameSync = origRename;
    const files = fs.readdirSync(dir);
    assert.equal(files.some(f => f.includes('.corrupt-')), false, 'must not backup intact files on EBUSY');
    assert.equal(files.some(f => f.endsWith('.tmp')), false, 'must unlink temp file on failed rename');
    assert.equal(storage.readConfig().defaultProvider, 'brave');
    assert.equal(storage.readAllCredentials().WEB_TOOLS_EXA, 'keep');
  `], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(storageRes.code, 0, storageRes.stderr);
});

test("remote web_mode mirrors mode to local mode-state.json and remote.json works without env vars", async (t) => {
  const requests: { url: string; auth: string | undefined }[] = [];
  const remote = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url ?? "", auth: req.headers.authorization });
    const parsed = JSON.parse(body || "{}");
    const mode = parsed.mode ?? "off";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      value: {
        sessionId: parsed.sessionId ?? "global",
        mode,
        globalMode: parsed.sessionId === "global" ? mode : "auto",
        sessionModeOverride: parsed.sessionId && parsed.sessionId !== "global" ? mode : null,
        available: true,
      },
    }));
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(async () => { remote.closeAllConnections(); await new Promise<void>((resolve) => remote.close(() => resolve())); });
  const port = (remote.address() as { port: number }).port;

  const home = fixture(t);
  fs.mkdirSync(path.join(home, "web-tools"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "web-tools", "remote.json"),
    JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "file-token" }),
  );

  // Strip KIMI_WEB_TOOLS_GATEWAY_URL so bin/mcp-server.mjs must pick up remote.json
  const envWithoutGw: Record<string, string | undefined> = { ...process.env, KIMI_CODE_HOME: home };
  delete envWithoutGw.KIMI_WEB_TOOLS_GATEWAY_URL;
  delete envWithoutGw.KIMI_WEB_TOOLS_GATEWAY_TOKEN;

  const setOff = await runNode(["bin/mcp-server.mjs"], envWithoutGw,
    rpc(1, "tools/call", { name: "web_mode", arguments: { action: "set", mode: "off", session_id: "global" } }));
  assert.equal(setOff.code, 0, setOff.stderr);
  assert.equal(requests[0].auth, "Bearer file-token");

  // Local pre-tool-gate.mjs must immediately see the mirrored "off" mode and block
  const gateBlocked = await runNode(["hooks/pre-tool-gate.mjs"], envWithoutGw, JSON.stringify({
    session_id: "s-sync",
    tool_name: "mcp__plugin-web_s__web_search",
    tool_input: { query: "test" },
  }));
  assert.equal(gateBlocked.code, 2, "pre-tool-gate must block after remote web_mode set off");

  // Switching back to auto mirrors locally and unblocks pre-tool-gate.mjs
  const setAuto = await runNode(["bin/mcp-server.mjs"], envWithoutGw,
    rpc(2, "tools/call", { name: "web_mode", arguments: { action: "set", mode: "auto", session_id: "global" } }));
  assert.equal(setAuto.code, 0, setAuto.stderr);
  const gateAllowed = await runNode(["hooks/pre-tool-gate.mjs"], envWithoutGw, JSON.stringify({
    session_id: "s-sync",
    tool_name: "mcp__plugin-web_s__web_search",
    tool_input: { query: "test" },
  }));
  assert.equal(gateAllowed.code, 0, gateAllowed.stderr);

  // Explicit empty KIMI_WEB_TOOLS_GATEWAY_URL="" must override remote.json back to local mode
  const closedServer = http.createServer((_, res) => res.writeHead(503).end());
  closedServer.listen(0, "127.0.0.1");
  await once(closedServer, "listening");
  const unusedPort = (closedServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => closedServer.close(() => resolve()));
  const forceLocal = await runNode(["bin/mcp-server.mjs"], {
    ...envWithoutGw,
    KIMI_WEB_TOOLS_PORT: String(unusedPort),
    KIMI_WEB_TOOLS_GATEWAY_URL: "",
  }, rpc(3, "tools/call", { name: "web_status" }));
  assert.equal(forceLocal.code, 0, forceLocal.stderr);
  const reply = JSON.parse(forceLocal.stdout.trim());
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Local gateway is not running/);

  // syncMode: false keeps web_mode strictly local without calling the remote gateway
  const beforeCalls = requests.length;
  fs.writeFileSync(
    path.join(home, "web-tools", "remote.json"),
    `\uFEFF${JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "file-token", syncMode: false })}`,
  );
  const localOnly = await runNode(["bin/mcp-server.mjs"], envWithoutGw,
    rpc(4, "tools/call", { name: "web_mode", arguments: { action: "set", mode: "required", session_id: "global" } }));
  assert.equal(localOnly.code, 0, localOnly.stderr);
  assert.equal(requests.length, beforeCalls, "syncMode: false must not send web_mode mutations to shared remote gateway");
  const modeDoc = JSON.parse(fs.readFileSync(path.join(home, "web-tools", "mode-state.json"), "utf8"));
  assert.equal(modeDoc.globalMode, "required");
});
