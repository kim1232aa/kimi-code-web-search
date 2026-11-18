/**
 * kimi-web-tools — Gateway authentication tests: password login with rate
 * limiting, revocable session tokens, and the unauthenticated /health probe.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
