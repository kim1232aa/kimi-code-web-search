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
