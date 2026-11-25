/**
 * kimi-code-web-search — Gateway authentication tests: password login with rate
 * limiting, revocable session tokens, and the unauthenticated /health probe.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGatewayServer } from "../src/host/gateway-server.ts";

// The direct-loopback bypass must be off for these tests, or every request
// would be authenticated without a password. Read per request; per-file process.
process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "test-gateway-pass";

async function authGateway(t: TestContext) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-auth-"));
  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir,
    projectRoot: ROOT,
    password: PASSWORD,
  });
  t.after(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  return handle;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("/health stays unauthenticated while the config plane requires login", async (t) => {
  const handle = await authGateway(t);
  const health = await fetch(`${handle.url}/health`);
  assert.equal(health.status, 200);
  const healthJson = (await health.json()) as { ok: boolean };
  assert.equal(healthJson.ok, true);

  const unauth = await post(`${handle.url}/web-tools/api/config/get`, {});
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("www-authenticate"), "Bearer");

  const bearer = await post(`${handle.url}/web-tools/api/config/get`, {}, { authorization: `Bearer ${PASSWORD}` });
  assert.equal(bearer.status, 200, "the gateway password must authenticate directly as a bearer token");
});

test("POST /mcp speaks stateless Streamable HTTP and requires the bearer token", async (t) => {
  const handle = await authGateway(t);
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    post(`${handle.url}/mcp`, body, { accept: "application/json, text/event-stream", ...headers });

  const refused = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(refused.status, 401, "a remote caller without the bearer token must be refused");

  const auth = { authorization: `Bearer ${PASSWORD}` };
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, auth);
  assert.equal(init.status, 200);
  const initBody = (await init.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(initBody.result.protocolVersion, "2025-06-18");
  assert.equal(initBody.result.serverInfo.name, "kimi-code-web-search");

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
  const listBody = (await list.json()) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(listBody.result.tools.map((tool) => tool.name), ["web_search", "web_fetch", "web_mode", "web_status"]);

  const notified = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, auth);
  assert.equal(notified.status, 202, "a notification has no body and no id");

  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_status", arguments: {} } }, auth);
  assert.equal(call.status, 200);
  const callBody = (await call.json()) as { result: { content: Array<{ text: string }> } };
  assert.match(callBody.result.content[0].text, /Usable search engines:/);
  assert.doesNotMatch(callBody.result.content[0].text, /Dashboard|Gateway bind|PID|"mode"|18492/i);

  const get = await fetch(`${handle.url}/mcp`);
  assert.equal(get.status, 405, "the endpoint is stateless and accepts POST only");
});

test("repeated failed logins lock the client out with 429 + Retry-After", async (t) => {
  const handle = await authGateway(t);
  for (let i = 0; i < 5; i++) {
    const bad = await post(`${handle.url}/web-tools/auth/login`, { password: "wrong-password" });
    assert.equal(bad.status, 401);
  }
  const locked = await post(`${handle.url}/web-tools/auth/login`, { password: PASSWORD });
  assert.equal(locked.status, 429, "even the correct password is refused while locked out");
  assert.ok(Number(locked.headers.get("retry-after")) >= 60, "Retry-After must advertise the base lockout window");
});

test("login issues a revocable session cookie", async (t) => {
  const handle = await authGateway(t);
  const login = await post(`${handle.url}/web-tools/auth/login`, { password: PASSWORD });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  const sessionCookie = setCookie.split(";")[0] ?? "";
  assert.match(sessionCookie, /^kimi_wt_session=[0-9a-f]{64}$/, "login must set a random revocable token, not a password-derived value");

  const authed = await post(`${handle.url}/web-tools/api/config/get`, {}, { cookie: sessionCookie });
  assert.equal(authed.status, 200, "the issued cookie must authenticate the config plane");

  const logout = await post(`${handle.url}/web-tools/auth/logout`, {}, { cookie: sessionCookie });
  assert.equal(logout.status, 200);

  const revoked = await post(`${handle.url}/web-tools/api/config/get`, {}, { cookie: sessionCookie });
  assert.equal(revoked.status, 401, "logout must actually revoke the session token");
});

function rawHttpRequest(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; chunks?: Buffer[] },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers },
      (res) => {
        const out: Buffer[] = [];
        res.on("data", (chunk: Buffer) => out.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(out).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    for (const chunk of options.chunks ?? []) {
      req.write(chunk);
    }
    req.end();
  });
}

test("malformed Host returns 400 and /web-tools/mcp/* handles bad JSON, >1MB payloads, split UTF-8, and GET mode", async (t) => {
  const handle = await authGateway(t);
  const auth = { authorization: `Bearer ${PASSWORD}` };

  const badHost = await rawHttpRequest(handle.port, { path: "/health", headers: { host: "bad host" } });
  assert.equal(badHost.status, 400);

  const rawBadJson = await rawHttpRequest(handle.port, {
    method: "POST",
    path: "/web-tools/mcp/search",
    headers: { ...auth, "content-type": "application/json" },
    chunks: [Buffer.from("{broken", "utf8")],
  });
  assert.equal(rawBadJson.status, 400);

  const oversized = await rawHttpRequest(handle.port, {
    method: "POST",
    path: "/web-tools/mcp/search",
    headers: { ...auth, "content-type": "application/json" },
    chunks: [Buffer.alloc(1_000_001, 0x61)],
  });
  assert.equal(oversized.status, 413);

  const getMode = await fetch(`${handle.url}/web-tools/mcp/mode`, { headers: auth });
  assert.equal(getMode.status, 200);

  // Split a 3-byte UTF-8 character across two chunks.
  const payload = Buffer.from('{"action":"get","sessionId":"中文会话"}', "utf8");
  const splitIdx = payload.indexOf(0xe4) + 1;
  const splitRes = await rawHttpRequest(handle.port, {
    method: "POST",
    path: "/web-tools/mcp/mode",
    headers: { ...auth, "content-type": "application/json" },
    chunks: [payload.subarray(0, splitIdx), payload.subarray(splitIdx)],
  });
  assert.equal(splitRes.status, 200);
  const splitJson = JSON.parse(splitRes.body) as { value: { sessionId: string } };
  assert.equal(splitJson.value.sessionId, "中文会话");
});

test("login rate-limits on rightmost X-Forwarded-For IP and normalizes X-Forwarded-Proto for Secure cookie", async (t) => {
  const handle = await authGateway(t);
  for (let i = 0; i < 5; i++) {
    const bad = await post(`${handle.url}/web-tools/auth/login`, { password: "wrong" }, {
      "x-forwarded-for": `spoof-${i}, 203.0.113.10`,
    });
    assert.equal(bad.status, 401);
  }
  const locked = await post(`${handle.url}/web-tools/auth/login`, { password: PASSWORD }, {
    "x-forwarded-for": "another-spoof, 203.0.113.10",
  });
  assert.equal(locked.status, 429, "lockout key must use rightmost X-Forwarded-For IP");

  const okOtherIp = await post(`${handle.url}/web-tools/auth/login`, { password: PASSWORD }, {
    "x-forwarded-for": "spoof-0, 203.0.113.11",
    "x-forwarded-proto": "HTTPS, http",
  });
  assert.equal(okOtherIp.status, 200);
  assert.match(okOtherIp.headers.get("set-cookie") ?? "", /;\s*Secure\b/);
});

test("web_status returns usable: [] when globally disabled and handle.close() drains keep-alive quickly", async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-auth-close-"));
  const handle = await startGatewayServer({ host: "127.0.0.1", port: 0, baseDir, projectRoot: ROOT, password: PASSWORD });
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  handle.storage.writeConfig({ enabled: false });
  handle.storage.setCredential("WEB_TOOLS_EXA", "exa-key-123");
  const statusRes = await post(`${handle.url}/web-tools/mcp/status`, {}, { authorization: `Bearer ${PASSWORD}` });
  assert.equal(statusRes.status, 200);
  const statusJson = (await statusRes.json()) as { value: { usable: string[] } };
  assert.deepEqual(statusJson.value.usable, []);

  // Open an idle keep-alive socket and verify close() does not wait 5s.
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: handle.port, path: "/health", agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
  });
  const started = Date.now();
  await handle.close();
  agent.destroy();
  assert.ok(Date.now() - started < 1500, "handle.close() should close keep-alive connections promptly");
});

test("least-privilege client tokens allow MCP/evaluate-turn/session mode but block management APIs and global mode mutation", async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-client-token-"));
  // Write client-token file with UTF-8 BOM and comments to verify file loading too.
  fs.writeFileSync(path.join(baseDir, "client-token"), "\uFEFF# guest token\nguest-token-123\n");
  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir,
    projectRoot: ROOT,
    password: PASSWORD,
  });
  t.after(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  handle.storage.setCredential("WEB_TOOLS_EXA", "owner-secret-key-999");
  handle.storage.setSessionMode("owner-private-session", "required");

  const guestHeaders = {
    authorization: "Bearer guest-token-123",
    "x-forwarded-for": "198.51.100.7",
  };

  // 1. Client token cannot log into Dashboard or hit /web-tools/api/* (prevents API key exfiltration via baseUrl poisoning)
  const sessionView = await fetch(`${handle.url}/web-tools/auth/session`, { headers: guestHeaders });
  assert.equal(((await sessionView.json()) as { value: { authenticated: boolean } }).value.authenticated, false);

  const loginAttempt = await post(`${handle.url}/web-tools/auth/login`, { password: "guest-token-123" }, {
    "x-forwarded-for": "198.51.100.7",
  });
  assert.equal(loginAttempt.status, 401);

  for (const apiPath of ["/web-tools/api/config/get", "/web-tools/api/config/save", "/web-tools/api/sources/endpoint-set", "/web-tools/api/credentials/describe"]) {
    const blocked = await post(`${handle.url}${apiPath}`, { providerBaseUrls: { exa: "https://attacker.example/v1" } }, guestHeaders);
    assert.equal(blocked.status, 403, `client token must be blocked from ${apiPath}`);
  }

  // 2. Client token cannot mutate globalMode via REST or /mcp, and cannot list owner sessions
  const globalSetRest = await post(`${handle.url}/web-tools/mcp/mode`, { action: "set", mode: "off", sessionId: "global" }, guestHeaders);
  assert.equal(globalSetRest.status, 403);
  const globalToggleRest = await post(`${handle.url}/web-tools/mcp/mode`, { action: "toggle", sessionId: "global" }, guestHeaders);
  assert.equal(globalToggleRest.status, 403);
  const globalSetMcp = await post(`${handle.url}/mcp`, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "web_mode", arguments: { action: "set", mode: "off", session_id: "global" } },
  }, guestHeaders);
  assert.equal(globalSetMcp.status, 200);
  const mcpErr = (await globalSetMcp.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.equal(mcpErr.result.isError, true);
  assert.match(mcpErr.result.content[0].text, /Client tokens cannot modify global search mode/);
  assert.equal(handle.storage.readModeState().globalMode, "auto");

  // Session-scoped mode set & get work, without leaking owner session list
  const ownSet = await post(`${handle.url}/web-tools/mcp/mode`, { action: "set", mode: "required", sessionId: "guest-s1" }, guestHeaders);
  assert.equal(ownSet.status, 200);
  const ownGet = await post(`${handle.url}/web-tools/mcp/mode`, { action: "get", sessionId: "guest-s1" }, guestHeaders);
  assert.equal(ownGet.status, 200);
  const ownGetJson = (await ownGet.json()) as { value: { mode: string; sessions?: unknown } };
  assert.equal(ownGetJson.value.mode, "required");
  assert.equal(ownGetJson.value.sessions, undefined, "client token must not see other sessions");

  // 3. /web-tools/mcp/status for client token returns usable engines only (no gateway bind/PID, no providers key hints)
  const statusRes = await post(`${handle.url}/web-tools/mcp/status`, { sessionId: "guest-s1" }, guestHeaders);
  assert.equal(statusRes.status, 200);
  const statusJson = (await statusRes.json()) as { value: Record<string, unknown> };
  assert.deepEqual(statusJson.value.usable, ["exa"]);
  assert.equal(statusJson.value.gateway, undefined);
  assert.equal(statusJson.value.providers, undefined);
  assert.equal(statusJson.value.config, undefined);

  // 4. /web-tools/mcp/evaluate-turn works for client token
  const evalRes = await post(`${handle.url}/web-tools/mcp/evaluate-turn`, {
    sessionId: "guest-s1",
    promptText: "hello",
  }, guestHeaders);
  assert.equal(evalRes.status, 200);
  const evalJson = (await evalRes.json()) as { value: { mode: string; readyProviders: string[] } };
  assert.equal(evalJson.value.mode, "required");
  assert.deepEqual(evalJson.value.readyProviders, ["exa"]);
});


test("invalid bearer tokens never inherit loopback admin, and browser cross-site checks cover clients", async (t) => {
  const previousRequireAuth = process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH;
  delete process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH;
  t.after(() => {
    if (previousRequireAuth === undefined) delete process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH;
    else process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH = previousRequireAuth;
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-loopback-auth-"));
  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir,
    projectRoot: ROOT,
    password: PASSWORD,
    clientTokens: ["guest-123456789012"],
  });
  t.after(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  for (const token of ["wrong-token", "revoked-client-token"]) {
    const response = await post(`${handle.url}/web-tools/api/config/get`, {}, { authorization: `Bearer ${token}` });
    assert.equal(response.status, 401, "an invalid bearer must not inherit direct-loopback admin");
  }
  const guest = { authorization: "Bearer guest-123456789012" };
  const normal = await post(`${handle.url}/web-tools/mcp/status`, {}, guest);
  assert.equal(normal.status, 200);
  const crossOrigin = await post(`${handle.url}/web-tools/mcp/status`, {}, { ...guest, origin: "https://attacker.example" });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await post(`${handle.url}/web-tools/mcp/status`, {}, { ...guest, "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
});

test("client mode namespaces, off ceiling, bounded state, and MCP parity", async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-client-isolation-"));
  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir,
    projectRoot: ROOT,
    password: PASSWORD,
    clientTokens: ["guest-123456789012", "other-123456789012"],
  });
  t.after(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  handle.storage.setSessionMode("owner-session", "required");
  handle.storage.setTurnState("guest-session", { turn: 7, required: true, corrections: 0, webSearchCompleted: false });
  const guest = { authorization: "Bearer guest-123456789012" };
  const other = { authorization: "Bearer other-123456789012" };

  const ownerSessionRead = await post(`${handle.url}/web-tools/mcp/mode`, { sessionId: "owner-session" }, guest);
  assert.equal(((await ownerSessionRead.json()) as { value: { mode: string } }).value.mode, "auto");
  const setOwn = await post(`${handle.url}/web-tools/mcp/mode`, { mode: "required", sessionId: "guest-session" }, guest);
  assert.equal(setOwn.status, 200, "mode alone must infer set for REST too");
  const otherRead = await post(`${handle.url}/web-tools/mcp/mode`, { sessionId: "guest-session" }, other);
  assert.equal(((await otherRead.json()) as { value: { mode: string } }).value.mode, "auto");
  assert.equal(handle.storage.getEffectiveSessionMode("guest-session"), "auto", "guest override must not create owner session mode");
  assert.equal(handle.storage.getEffectiveSessionMode("owner-session"), "required");
  assert.equal(handle.storage.getTurnState("guest-session")?.turn, 7);

  const noKeySearch = await post(`${handle.url}/web-tools/mcp/search`, { query: "test", sessionId: "guest-session", turnId: 7 }, guest);
  assert.equal(noKeySearch.status, 500, "the unconfigured provider fails without starting a search");
  assert.equal(handle.storage.getTurnState("guest-session")?.webSearchCompleted, false, "guest search must not mutate owner turn accounting");

  const modeRpc = await post(`${handle.url}/mcp`, {
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { name: "web_mode", arguments: { mode: "smart", session_id: "guest-session" } },
  }, guest);
  const modeRpcJson = (await modeRpc.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.notEqual(modeRpcJson.result.isError, true, "mode without action must infer set over MCP");
  assert.match(modeRpcJson.result.content[0].text, /Effective Mode: smart/);
  assert.match(modeRpcJson.result.content[0].text, /Search Provider Available: yes/);

  for (const invalidSession of ["__proto__", "x".repeat(129)]) {
    const invalid = await post(`${handle.url}/web-tools/mcp/mode`, { mode: "required", sessionId: invalidSession }, guest);
    assert.equal(invalid.status, 400);
  }
  // Per-token LRU: one guest flooding 201 entries must not evict another
  // guest's modes, and the owner "client:ops" session is not a client key.
  const beforeFlood = await post(`${handle.url}/web-tools/mcp/mode`, { mode: "required", sessionId: "victim-session" }, other);
  assert.equal(beforeFlood.status, 200);
  handle.storage.setSessionMode("client:ops", "required");
  for (let index = 0; index < 201; index += 1) {
    handle.storage.setClientSessionMode("load-test", `session-${index}`, "required");
  }
  const docAfterFlood = handle.storage.readModeState();
  const floodTokenKeys = Object.keys(docAfterFlood.sessions).filter((key) => key.startsWith("client:load-test:"));
  assert.ok(floodTokenKeys.length <= 200, "per-token client overrides must be LRU-bounded");
  assert.ok(Object.keys(docAfterFlood.sessions).some((key) => key.includes(":victim-session")), "flood from one guest must not evict another guest's sessions");
  assert.equal(docAfterFlood.sessions["client:ops"]?.mode, "required", "owner client:-prefixed session is not evictable client state");
  const victimRead = await post(`${handle.url}/web-tools/mcp/mode`, { sessionId: "victim-session" }, other);
  assert.equal(((await victimRead.json()) as { value: { mode: string } }).value.mode, "required");
  const adminModes = await post(`${handle.url}/web-tools/mcp/mode`, {}, { authorization: `Bearer ${PASSWORD}` });
  const adminModesJson = (await adminModes.json()) as { value: { sessions: Array<{ id: string }> } };
  assert.equal(adminModesJson.value.sessions.some((entry) => /^client:[0-9a-f]{12}:/.test(entry.id)), false, "dashboard hides real client keys");
  assert.ok(adminModesJson.value.sessions.some((entry) => entry.id === "client:ops"), "owner client:-prefixed session stays visible");

  handle.storage.setSessionMode("global", "off");
  const guestSearchOff = await post(`${handle.url}/web-tools/mcp/search`, { query: "test", sessionId: "guest-session" }, guest);
  assert.equal(guestSearchOff.status, 403);
  const guestEvalOff = await post(`${handle.url}/web-tools/mcp/evaluate-turn`, {
    sessionId: "guest-session", modeHint: "smart", promptText: "latest news",
  }, guest);
  const guestEvalOffJson = (await guestEvalOff.json()) as { value: { exempted: boolean; readyProviders: string[]; decision?: unknown } };
  assert.equal(guestEvalOffJson.value.exempted, true, "off gateway must exempt an independently required local client");
  assert.deepEqual(guestEvalOffJson.value.readyProviders, []);
  assert.equal(guestEvalOffJson.value.decision, undefined, "off gateway must never classify");
  const syncedOff = await post(`${handle.url}/web-tools/mcp/evaluate-turn`, { promptText: "latest news" }, guest);
  assert.equal(((await syncedOff.json()) as { value: { exempted: boolean } }).value.exempted, false);

  handle.storage.setSessionMode("global", "auto");
  const setSessionOff = await post(`${handle.url}/web-tools/mcp/mode`, { sessionId: "guest-session", mode: "off" }, guest);
  assert.equal(setSessionOff.status, 200);
  const sessionEvalOff = await post(`${handle.url}/web-tools/mcp/evaluate-turn`, {
    sessionId: "guest-session", modeHint: "smart", promptText: "latest news",
  }, guest);
  const sessionEvalOffJson = (await sessionEvalOff.json()) as { value: { mode: string; exempted: boolean; decision?: unknown } };
  assert.equal(sessionEvalOffJson.value.mode, "off");
  assert.equal(sessionEvalOffJson.value.exempted, true);
  assert.equal(sessionEvalOffJson.value.decision, undefined);
  const sessionSearchOff = await post(`${handle.url}/web-tools/mcp/search`, {
    query: "test", session_id: "guest-session",
  }, guest);
  assert.equal(sessionSearchOff.status, 403);
});


test("direct loopback survives password configuration, authorization schemes cannot bypass, and BOM config remains intact", async (t) => {
  const previousRequireAuth = process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH;
  delete process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH;
  t.after(() => {
    if (previousRequireAuth === undefined) delete process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH;
    else process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH = previousRequireAuth;
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-loopback-compat-"));
  fs.writeFileSync(path.join(baseDir, "config.json"), "\uFEFF{\"enabled\":true,\"exemptWhenNoProvider\":false}", "utf8");
  fs.writeFileSync(path.join(baseDir, "credentials.json"), "\uFEFF{\"WEB_TOOLS_EXA\":\"fixture-key\"}", "utf8");
  const handle = await startGatewayServer({
    host: "127.0.0.1", port: 0, baseDir, projectRoot: ROOT, password: PASSWORD,
  });
  t.after(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const localStatus = await post(`${handle.url}/web-tools/mcp/status`, {});
  assert.equal(localStatus.status, 200, "configured password must not break direct loopback admin");
  assert.deepEqual(((await localStatus.json()) as { value: { usable: string[] } }).value.usable, ["exa"]);
  assert.ok(fs.existsSync(path.join(baseDir, "config.json")), "BOM config must not be renamed to corrupt");
  assert.ok(fs.existsSync(path.join(baseDir, "credentials.json")), "BOM credentials must not be renamed to corrupt");
  assert.equal(fs.readdirSync(baseDir).some((file) => file.includes(".corrupt-")), false);
  for (const authorization of ["Basic YWRtaW46YWRtaW4=", "Bearer revoked-token"]) {
    const invalid = await post(`${handle.url}/web-tools/api/config/get`, {}, { authorization });
    assert.equal(invalid.status, 401);
  }

  handle.storage.setSessionMode("global", "required");
  handle.storage.setSessionMode("owner-pinned", "required");
  const pinned = await post(`${handle.url}/web-tools/mcp/mode`, { sessionId: "owner-pinned" });
  assert.equal(((await pinned.json()) as { value: { sessionModeOverride: string | null } }).value.sessionModeOverride, "required");
  const aliasSet = await post(`${handle.url}/web-tools/mcp/mode`, { mode: "off", session_id: "s-alias" });
  assert.equal(aliasSet.status, 200);
  assert.equal(handle.storage.readModeState().globalMode, "required");
  assert.equal(handle.storage.getEffectiveSessionMode("s-alias"), "off");
  const aliasSearch = await post(`${handle.url}/web-tools/mcp/search`, { query: "test", session_id: "s-alias" });
  assert.equal(aliasSearch.status, 403, "REST snake_case session_id must use the same target as MCP");
});


test("Streamable HTTP search validates explicit null max_results and non-string provider", async (t) => {
  const handle = await authGateway(t);
  const headers = { authorization: `Bearer ${PASSWORD}` };
  for (const [id, args, expected] of [
    [90, { query: "test", max_results: null }, /max_results must be a positive integer/],
    [91, { query: "test", provider: 123 }, /provider must be a string/],
  ] as const) {
    const response = await post(`${handle.url}/mcp`, {
      jsonrpc: "2.0", id, method: "tools/call", params: { name: "web_search", arguments: args },
    }, headers);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, expected);
  }
});
