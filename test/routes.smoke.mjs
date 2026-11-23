/**
 * Route-level smoke tests: register the /web-tools/api routes on a mock
 * webServer + deps, then exercise the endpoints exactly as the browser card
 * would. Uses node:test + assert — a failed assertion FAILS the run.
 *
 * Run: node --experimental-strip-types --test test/routes.smoke.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { registerRoutes, API_PREFIX, isProxiedRequest, isDirectLoopbackRequest, configPlaneTrust } from "../src/host/routes.ts";

/** Minimal mock webServer that captures the registered handler. */
function mockServer() {
  let handler;
  const server = {
    register: (route) => {
      handler = route.handler;
      return () => {};
    },
  };
  return { server, getHandler: () => handler };
}

/** Build a fake req/res pair for one POST. */
function fakeReqRes(method, url, body, host = "127.0.0.1:3080", extraHeaders = {}) {
  const req = {
    url,
    method,
    headers: { host, ...extraHeaders },
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify(body ?? {});
    },
  };
  const res = { statusCode: 0, headers: {}, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b) { this.body = String(b ?? ""); } };
  return { req, res };
}

const deps = {
  readConfig: () => ({
    enabled: true,
    defaultProvider: "tavily",
    providerAttemptTimeoutMs: 10000,
    fallbackOrder: ["exa"],
    providerBaseUrls: { searxng: "http://127.0.0.1:8080" },
    providerEnabled: {},
  }),
  writeConfig: async () => {},
  readCredential: async (ref) => {
    if (ref === "WEB_TOOLS_TAVILY") return { configured: true, writable: true, value: "tvly-dev-key-one-1234,tvly-dev-key-two-5678" };
    if (ref === "WEB_TOOLS_EXA") return { configured: true, writable: true, value: "exa-key-0001" };
    return { configured: false, writable: true };
  },
  writeCredential: async () => {},
  testProviderSearch: async (provider, query) => ({ ok: true, provider, query, latencyMs: 100, resultCount: 3 }),
  testFullSearch: async (query, provider) => ({ ok: true, backend: provider ?? "tavily", latencyMs: 200, resultCount: 3, attempts: [{ provider: "tavily", outcome: "success", latencyMs: 200 }] }),
  describeQuotas: async () => ({ tavily: { supported: true, authoritative: true, unit: "credits", remaining: 950, limit: 1000, source: "api", fetchedAt: Date.now() } }),
  searchMode: (() => {
    let mode = "auto";
    return {
      view: (sessionId) => ({ mode, available: true }),
      set: (sessionId, next) => { mode = next; return { mode, available: true }; },
    };
  })(),
};

const { server, getHandler } = mockServer();
registerRoutes({ webServer: server, webRuntime: { trustedHosts: [] } }, deps);
const handler = getHandler();

async function call(method, payload, opts = {}) {
  const { req, res } = fakeReqRes("POST", `${API_PREFIX}/${method}`, payload, opts.host, opts.headers);
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

test("config/get returns providers with real pool size and no fake health", async () => {
  const { status, body } = await call("config/get");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const cfg = body.value;
  assert.equal(cfg.defaultProvider, "tavily");
  assert.equal(cfg.providerAttemptTimeoutMs, 10000);
  const tavily = cfg.providers.find((p) => p.name === "tavily");
  assert.ok(tavily);
  assert.equal(tavily.poolSize, 2);
  // pool health/uses are runtime Router state — config/get must NOT expose it
  assert.equal("pool" in tavily, false);
});

test("config/get exposes per-key masked hints with stable ids (no secrets)", async () => {
  const { status, body } = await call("config/get");
  assert.equal(status, 200);
  const tavily = body.value.providers.find((p) => p.name === "tavily");
  assert.ok(Array.isArray(tavily.keys), "keys array present");
  assert.equal(tavily.keys.length, 2);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("tvly-dev-key-one-1234") && !raw.includes("tvly-dev-key-two-5678"), "full keys leaked in keys[]");
  for (const k of tavily.keys) {
    assert.equal(typeof k.id, "string");
    assert.equal(k.id.length, 8, "key id is an 8-char opaque hash");
    assert.ok(k.hint.includes("…"), "hint is masked");
    assert.equal(typeof k.healthy, "boolean");
  }
  assert.notEqual(tavily.keys[0].id, tavily.keys[1].id, "distinct keys get distinct ids");
});

test("credentials/describe never leaks credential values", async () => {
  const { status, body } = await call("credentials/describe");
  assert.equal(status, 200);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("tvly-dev-key-one-1234") && !raw.includes("tvly"), "credential values leaked");
  const tavily = body.value.credentials["WEB_TOOLS_TAVILY"];
  assert.equal(tavily.configured, true);
  assert.equal(tavily.writable, true);
});

test("quota/describe returns the authoritative snapshot", async () => {
  const { status, body } = await call("quota/describe");
  assert.equal(status, 200);
  assert.equal(body.value.quotas.tavily.remaining, 950);
  assert.equal(body.value.quotas.tavily.authoritative, true);
});

test("test/search reports backend and attempts", async () => {
  const { status, body } = await call("test/search", { query: "DeepSeek Harness" });
  assert.equal(status, 200);
  assert.equal(body.value.ok, true);
  assert.equal(body.value.backend, "tavily");
  assert.ok(Array.isArray(body.value.attempts) && body.value.attempts.length > 0);
});

test("config/save persists BEFORE returning saved:true", async () => {
  let persisted = false;
  const saveDeps = {
    ...deps,
    writeConfig: async () => {
      await new Promise((r) => setTimeout(r, 5)); // simulate async persistence
      persisted = true;
    },
  };
  const { server: s2, getHandler: g2 } = mockServer();
  registerRoutes({ webServer: s2, webRuntime: { trustedHosts: [] } }, saveDeps);
  const h2 = g2();
  const { req, res } = fakeReqRes("POST", `${API_PREFIX}/config/save`, { defaultProvider: "exa" });
  await h2(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(persisted, true, "config/save returned success before persistence finished");
});

// ---- security: configuration plane is loopback + same-origin only ----------

test("non-loopback host is rejected (403) — trustedHosts is NOT auth", async () => {
  const { status } = await call("config/get", {}, { host: "192.168.1.50:3080" });
  assert.equal(status, 403);
});

test("cross-site browser request is rejected (403)", async () => {
  const { status } = await call("config/save", { defaultProvider: "exa" }, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(status, 403);
});

test("credentials/set on a LAN host is rejected (403)", async () => {
  const { status } = await call("credentials/set", { provider: "tavily", value: "SECRET" }, { host: "tailnet-name:3080" });
  assert.equal(status, 403);
});

// ---- multi-key pool management (add-key / remove-key) -----------------------

test("credentials/add-key appends one key and persists the joined string", async () => {
  let written;
  const addDeps = {
    ...deps,
    writeCredential: async (ref, value) => { written = value; },
  };
  const { server: s, getHandler: g } = mockServer();
  registerRoutes({ webServer: s, webRuntime: { trustedHosts: [] } }, addDeps);
  const h = g();
  const { req, res } = fakeReqRes("POST", `${API_PREFIX}/credentials/add-key`, { provider: "tavily", value: "tvly-dev-key-three-9999" });
  await h(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.value.poolSize, 3);
  assert.equal(written, "tvly-dev-key-one-1234,tvly-dev-key-two-5678,tvly-dev-key-three-9999", "storage stays a comma-joined string");
});

test("credentials/add-key rejects duplicates", async () => {
  const { status, body } = await call("credentials/add-key", { provider: "tavily", value: "tvly-dev-key-one-1234" });
  assert.equal(status, 500);
  assert.equal(body.ok, false);
});

test("credentials/remove-key removes by opaque id, not by value", async () => {
  let written;
  const rmDeps = {
    ...deps,
    writeCredential: async (ref, value) => { written = value; },
  };
  const { server: s, getHandler: g } = mockServer();
  registerRoutes({ webServer: s, webRuntime: { trustedHosts: [] } }, rmDeps);
  const h = g();

  // discover the id for the second key via config/get (ids are per-key stable)
  const cfgReq = fakeReqRes("POST", `${API_PREFIX}/config/get`, {});
  await h(cfgReq.req, cfgReq.res);
  const cfg = JSON.parse(cfgReq.res.body).value;
  const tavily = cfg.providers.find((p) => p.name === "tavily");
  const k2id = tavily.keys.find((k) => k.hint.endsWith("5678"))?.id ?? tavily.keys[1].id;

  const { req, res } = fakeReqRes("POST", `${API_PREFIX}/credentials/remove-key`, { provider: "tavily", keyId: k2id });
  await h(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.value.poolSize, 1);
  assert.equal(written, "tvly-dev-key-one-1234", "remaining key re-joined without the removed one");
});

test("credentials/remove-key with an unknown id fails cleanly", async () => {
  const { status, body } = await call("credentials/remove-key", { provider: "tavily", keyId: "deadbeef" });
  assert.equal(status, 500);
  assert.equal(body.ok, false);
});

test("removing the LAST key writes an empty value (routes hand empty to the writer; the host turns it into unset)", async () => {
  // Live credential store: readCredential reflects prior removals, like the
  // real host (a static mock would re-read the original two-key pool every time).
  let store = "tvly-dev-key-one-1234,tvly-dev-key-two-5678";
  let written;
  const rmDeps = {
    ...deps,
    readCredential: async (ref) => ({ configured: store.length > 0, writable: true, value: store }),
    writeCredential: async (ref, value) => { written = { ref, value }; store = value; },
  };
  const { server: s, getHandler: g } = mockServer();
  registerRoutes({ webServer: s, webRuntime: { trustedHosts: [] } }, rmDeps);
  const h = g();

  // Discover both key ids via config/get.
  const cfgReq = fakeReqRes("POST", `${API_PREFIX}/config/get`, {});
  await h(cfgReq.req, cfgReq.res);
  const cfg = JSON.parse(cfgReq.res.body).value;
  const tavily = cfg.providers.find((p) => p.name === "tavily");
  const ids = tavily.keys.map((k) => k.id);

  for (const keyId of ids) {
    const { req, res } = fakeReqRes("POST", `${API_PREFIX}/credentials/remove-key`, { provider: "tavily", keyId });
    await h(req, res);
    assert.equal(JSON.parse(res.body).ok, true);
  }
  assert.ok(written, "writer called on last removal");
  assert.equal(written.value, "", "last key removal hands an empty value (host unsets)");
  assert.equal(written.ref, "WEB_TOOLS_TAVILY");
});

test("search-mode/get returns the mode + availability and validation rejects a bad session", async () => {
  const { status, body } = await call("search-mode/get", { sessionId: "sess-1" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.value, { mode: "auto", available: true });

  const missing = await call("search-mode/get", {});
  assert.equal(missing.status, 500);
  assert.equal(missing.body.ok, false);
});

test("search-mode/set toggles and persists, rejecting invalid modes", async () => {
  const on = await call("search-mode/set", { sessionId: "sess-2", mode: "required" });
  assert.equal(on.status, 200);
  assert.equal(on.body.value.mode, "required");
  // The same runtime reflects the new mode on read-back.
  const again = await call("search-mode/get", { sessionId: "sess-2" });
  assert.equal(again.body.value.mode, "required");

  const invalid = await call("search-mode/set", { sessionId: "sess-2", mode: "banana" });
  assert.equal(invalid.status, 500);
  assert.equal(invalid.body.ok, false);
});


test("search-mode/set accepts smart and returns it on read-back", async () => {
  const result = await call("search-mode/set", { sessionId: "sess-smart", mode: "smart" });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.value.mode, "smart");
  const again = await call("search-mode/get", { sessionId: "sess-smart" });
  assert.equal(again.body.value.mode, "smart");
});

test("config/get and config/save preserve smartSearch without exposing classifier secrets", async () => {
  const original = {
    enabled: true,
    provider: "typesafe",
    model: "test-classifier",
    baseUrl: "https://example.org/v1",
    timeoutMs: 1500,
    threshold: 0.5,
    failOpen: true,
    enableTranscriptContext: true,
  };
  let config = { ...deps.readConfig(), smartSearch: original, exemptWhenNoProvider: true, recognizeExternalWebTools: false };
  const localDeps = {
    ...deps,
    readConfig: () => config,
    writeConfig: async (patch) => { config = { ...config, ...patch }; },
    readCredential: async (ref) => ref === "WEB_TOOLS_TYPESAFE"
      ? { configured: true, writable: true, value: "test-classifier-key" }
      : deps.readCredential(ref),
  };
  const { server: localServer, getHandler: localHandler } = mockServer();
  registerRoutes({ webServer: localServer, webRuntime: { trustedHosts: [] } }, localDeps);
  const invoke = async (method, payload) => {
    const { req, res } = fakeReqRes("POST", `${API_PREFIX}/${method}`, payload);
    await localHandler()(req, res);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(!res.body.includes("test-classifier-key"), "classifier key must not leak");
    return body.value;
  };
  const initial = await invoke("config/get", {});
  assert.deepEqual(initial.smartSearch, original);
  assert.equal(initial.smartSearchConfigured, true);
  assert.equal(initial.exemptWhenNoProvider, true);
  assert.equal(initial.recognizeExternalWebTools, false);
  const changed = { ...original, provider: "openai-compatible", model: "test-chat-classifier", threshold: 0.7, enableTranscriptContext: false };
  const saved = await invoke("config/save", { smartSearch: changed, exemptWhenNoProvider: false, recognizeExternalWebTools: true });
  assert.equal(saved.saved, true);
  assert.deepEqual(config.smartSearch, changed);
  const after = await invoke("config/get", {});
  assert.deepEqual(after.smartSearch, changed);
  assert.equal(after.exemptWhenNoProvider, false);
  assert.equal(after.recognizeExternalWebTools, true);
});

test("smart-classifier/test returns a structured view from the configured classifier", async (t) => {
  const requests = [];
  const classifier = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: {
      needs_external_lookup: { noul: 0.8 },
      involves_tool_or_config_claim: { noul: 0.1 },
    } }));
  });
  await new Promise((resolve, reject) => {
    classifier.once("error", reject);
    classifier.listen(0, "127.0.0.1", () => {
      classifier.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    classifier.closeAllConnections();
    await new Promise((resolve, reject) => classifier.close((error) => error ? reject(error) : resolve()));
  });
  const address = classifier.address();
  assert.ok(address && typeof address !== "string");
  const smartSearch = {
    enabled: true, provider: "typesafe", model: "test-classifier",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, timeoutMs: 1000,
    threshold: 0.5, failOpen: true, enableTranscriptContext: false,
  };
  const localDeps = {
    ...deps,
    readConfig: () => ({ ...deps.readConfig(), smartSearch }),
    readCredential: async (ref) => ref === "WEB_TOOLS_TYPESAFE"
      ? { configured: true, writable: true, value: "test-classifier-key" }
      : deps.readCredential(ref),
  };
  const { server: localServer, getHandler: localHandler } = mockServer();
  registerRoutes({ webServer: localServer, webRuntime: { trustedHosts: [] } }, localDeps);
  const { req, res } = fakeReqRes("POST", `${API_PREFIX}/smart-classifier/test`, {
    prompt: "Verify the latest example package release.", sessionId: "classifier-route-test",
  });
  await localHandler()(req, res);
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.value.ok, true);
  assert.equal(body.value.escalated, true);
  assert.equal(body.value.provider, "typesafe");
  assert.equal(body.value.model, "test-classifier");
  assert.equal(body.value.threshold, 0.5);
  assert.equal(typeof body.value.latencyMs, "number");
  assert.deepEqual(body.value.probabilities, { needs_external_lookup: 0.8, involves_tool_or_config_claim: 0.1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/systemone");
  assert.ok(!res.body.includes("test-classifier-key"), "test response must not expose credentials");
});

for (const [label, baseUrl] of [
  ["a private IPv4 address", "https://10.0.0.1/v1"],
  ["non-loopback plaintext HTTP", "http://example.org/v1"],
]) {
  test(`smart-classifier/test rejects ${label} with HTTP 400 and makes no outbound call`, async (t) => {
    const outbound = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      outbound.push(args[0]);
      throw new Error("outbound request must not be attempted for a rejected base URL");
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const localDeps = {
      ...deps,
      readConfig: () => ({ ...deps.readConfig(), smartSearch: { provider: "typesafe", model: "test-classifier" } }),
      readCredential: async (ref) => ref === "WEB_TOOLS_TYPESAFE"
        ? { configured: true, writable: true, value: "test-classifier-key" }
        : deps.readCredential(ref),
    };
    const { server: localServer, getHandler: localHandler } = mockServer();
    registerRoutes({ webServer: localServer, webRuntime: { trustedHosts: [] } }, localDeps);
    const { req, res } = fakeReqRes("POST", `${API_PREFIX}/smart-classifier/test`, {
      prompt: "Verify the latest example package release.",
      provider: "typesafe",
      model: "test-classifier",
      baseUrl,
    });
    await localHandler()(req, res);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(JSON.parse(res.body).ok, false);
    assert.deepEqual(outbound, [], "a rejected base URL must never be dialed");
    assert.ok(!res.body.includes("test-classifier-key"), "rejection must not expose credentials");
  });
}

test("config/save validates and persists fetchOrder while rejecting unknown fetch providers", async () => {
  let config = { ...deps.readConfig() };
  const localDeps = {
    ...deps,
    readConfig: () => config,
    writeConfig: async (patch) => { config = { ...config, ...patch }; },
  };
  const { server: localServer, getHandler: localHandler } = mockServer();
  registerRoutes({ webServer: localServer, webRuntime: { trustedHosts: [] } }, localDeps);

  const saveOk = fakeReqRes("POST", `${API_PREFIX}/config/save`, { fetchOrder: ["exa", "builtin-http", "firecrawl", "jina"] });
  await localHandler()(saveOk.req, saveOk.res);
  assert.equal(saveOk.res.statusCode, 200, saveOk.res.body);
  assert.deepEqual(config.fetchOrder, ["exa", "http", "firecrawl", "jina"]);

  const getRes = fakeReqRes("POST", `${API_PREFIX}/config/get`, {});
  await localHandler()(getRes.req, getRes.res);
  assert.equal(getRes.res.statusCode, 200);
  assert.deepEqual(JSON.parse(getRes.res.body).value.fetchOrder, ["exa", "http", "firecrawl", "jina"]);

  const badRes = fakeReqRes("POST", `${API_PREFIX}/config/save`, { fetchOrder: ["exa", "not-a-provider"] });
  await localHandler()(badRes.req, badRes.res);
  assert.equal(badRes.res.statusCode, 400, badRes.res.body);
});

test("security helpers detect proxy headers, malformed Host, and normalized x-forwarded-proto", () => {
  for (const [hdr, val] of [
    ["x-forwarded-proto", ["https"]],
    ["forwarded", "for=192.0.2.1"],
    ["via", "1.1 proxy"],
    ["cf-connecting-ip", "198.51.100.1"],
    ["true-client-ip", "198.51.100.2"],
    ["x-forwarded-host", "example.com"],
  ]) {
    assert.equal(isProxiedRequest({ headers: { [hdr]: val } }), true, `expected proxy detection for ${hdr}`);
  }
  assert.equal(isDirectLoopbackRequest({ headers: { host: "bad host" }, socket: { remoteAddress: "127.0.0.1" } }), false);
  assert.equal(
    configPlaneTrust({
      headers: { host: "127.0.0.1:3080", origin: "https://127.0.0.1:3080", "x-forwarded-proto": "HTTPS, http" },
      socket: { remoteAddress: "127.0.0.1" },
    }),
    false,
    "proxied loopback peer is still rejected when not gateway-authenticated",
  );
  assert.equal(
    configPlaneTrust({
      headers: { host: "127.0.0.1:3080", origin: "https://127.0.0.1:3080", "x-forwarded-proto": "HTTPS, http" },
    }),
    "host",
  );
});

test("routes readJsonBody decodes split multi-byte UTF-8 chunks cleanly", async () => {
  let received;
  const localDeps = { ...deps, searchMode: { view: (id) => ({ mode: "auto", id }), set: (id, m) => ({ mode: m, id }) } };
  const { server: s, getHandler: g } = mockServer();
  registerRoutes({ webServer: s, webRuntime: { trustedHosts: [] } }, localDeps);
  const buf = Buffer.from('{"sessionId":"中文会话"}', "utf8");
  const split = buf.indexOf(0xe4) + 1;
  const req = {
    url: `${API_PREFIX}/search-mode/get`,
    method: "POST",
    headers: { host: "127.0.0.1:3080" },
    async *[Symbol.asyncIterator]() {
      yield buf.subarray(0, split);
      yield buf.subarray(split);
    },
  };
  const res = { statusCode: 0, headers: {}, body: "", writeHead(st, h) { this.statusCode = st; this.headers = h; }, end(b) { this.body = String(b ?? ""); } };
  await g()(req, res);
  assert.equal(res.statusCode, 200, res.body);
  received = JSON.parse(res.body);
  assert.equal(received.value.id, "中文会话");
});

test("config/get uses DEFAULT_PROVIDER (exa), ANDs custom enabled flags; config/save rejects query/hash; import/pi checks source === local", async (t) => {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-pi-smoke-"));
  const prevPiDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piDir;
  t.after(() => {
    if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevPiDir;
    fs.rmSync(piDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(piDir, "web-search.json"), JSON.stringify({ exaApiKey: "exa-pi-new" }));

  const writtenCreds = {};
  const localDeps = {
    ...deps,
    readConfig: () => ({
      enabled: true,
      providerEnabled: { custom_disabled01: true },
      customProviders: [{
        schemaVersion: 1,
        id: "custom_disabled01",
        name: "Disabled Custom",
        enabled: false,
        protocol: "generic-json",
        endpoint: { baseUrl: "https://api.example.com", searchPath: "/search", method: "GET", encoding: "query" },
        auth: { mode: "none" },
        revision: 1,
      }],
    }),
    readCredential: async (ref) => ({ configured: ref === "WEB_TOOLS_EXA", source: "env", writable: true, value: "env-secret" }),
    writeCredential: async (ref, val) => { writtenCreds[ref] = val; },
  };
  const { server: s, getHandler: g } = mockServer();
  registerRoutes({ webServer: s, webRuntime: { trustedHosts: [] } }, localDeps);
  const invoke = async (method, payload) => {
    const { req, res } = fakeReqRes("POST", `${API_PREFIX}/${method}`, payload);
    await g()(req, res);
    return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
  };

  const cfg = await invoke("config/get", {});
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.value.defaultProvider, "exa");
  const custom = cfg.body.value.providers.find((p) => p.name === "custom_disabled01");
  assert.equal(custom.enabled, false);

  const badQuery = await invoke("config/save", { providerBaseUrls: { exa: "https://proxy.example.com?token=1" } });
  assert.equal(badQuery.status, 400);
  const badHash = await invoke("config/save", { providerBaseUrls: { exa: "https://proxy.example.com#frag" } });
  assert.equal(badHash.status, 400);

  const imported = await invoke("import/pi", {});
  assert.equal(imported.status, 200);
  assert.equal(writtenCreds.WEB_TOOLS_EXA, "exa-pi-new", "env-sourced credential must not be merged into credentials.json");
});
