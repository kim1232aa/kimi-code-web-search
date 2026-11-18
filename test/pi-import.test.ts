import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importFromPi } from "../src/host/pi-import.ts";
import { LocalStorage } from "../src/host/local-storage.ts";
import { registerRoutes, API_PREFIX } from "../src/host/routes.ts";
import { SpecializedSourceRegistry } from "../src/host/sources/registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempFixtureDir(t: any, name: string): string {
  const parent = path.join(ROOT, "temp", "pi-import-tests");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("importFromPi imports Jev auth, search keys, base URLs, routing, and mode while skipping dynamic sources", async (t) => {
  const piDir = tempFixtureDir(t, "pi");
  const kimiHome = tempFixtureDir(t, "kimi");

  fs.writeFileSync(
    path.join(piDir, "auth.json"),
    JSON.stringify({
      typesafe: { type: "api_key", key: "ts-test-secret-001" },
      openrouter: { type: "api_key", key: "or-test-secret-002" },
      anthropic: { type: "oauth", access: "ignored" },
    }),
  );
  fs.writeFileSync(
    path.join(piDir, "web-search.json"),
    JSON.stringify({
      exaApiKey: "exa-test-001,exa-test-002",
      tavilyApiKey: ["tvly-test-001"],
      braveApiKey: "!op read op://vault/brave/key",
      youApiKey: "$YDC_API_KEY",
      jinaApiKey: "jina-test-001",
      searxngBaseUrl: "http://127.0.0.1:8888",
      exaBaseUrl: "http://insecure.example.org/exa",
      defaultProvider: "tavily",
      searchRouting: ["exa", "jina", "unknown-provider"],
    }),
  );
  fs.writeFileSync(path.join(piDir, "search-mode.json"), JSON.stringify({ mode: "always" }));

  const storage = new LocalStorage(path.join(kimiHome, "web-tools"));
  storage.ensureDir();
  storage.setCredential("WEB_TOOLS_EXA", "exa-test-001");

  const view = await importFromPi(
    {
      readConfig: () => storage.readConfig() as unknown as Record<string, unknown>,
      writeConfig: async (patch) => {
        storage.writeConfig(patch);
      },
      readCredential: async (ref) => {
        const res = storage.resolveCredential(ref);
        return { value: res?.source === "local" ? res.value : undefined };
      },
      writeCredential: async (ref, value) => {
        storage.setCredential(ref, value);
      },
      setGlobalMode: (mode) => {
        storage.setSessionMode("global", mode);
      },
    },
    { piDir },
  );

  const rawView = JSON.stringify(view);
  assert.ok(!rawView.includes("ts-test-secret-001"), "never expose typesafe secret");
  assert.ok(!rawView.includes("or-test-secret-002"), "never expose openrouter secret");
  assert.ok(!rawView.includes("exa-test-002"), "never expose exa secret");
  assert.ok(!rawView.includes("tvly-test-001"), "never expose tavily secret");

  assert.deepEqual(view.importedSmartProviders, ["typesafe", "openrouter"]);
  assert.deepEqual(view.importedSearchProviders, ["exa", "tavily", "jina"]);
  assert.deepEqual(view.importedBaseUrls, ["searxng"]);
  assert.equal(view.importedMode, "required");
  assert.deepEqual(view.importedRouting, { defaultProvider: "tavily", fallbackOrder: ["exa", "jina"] });
  assert.deepEqual(view.skipped, [
    { source: "web-search.json:braveApiKey", reason: "dynamic-command-or-env-ref" },
    { source: "web-search.json:youApiKey", reason: "dynamic-command-or-env-ref" },
    { source: "web-search.json:exaBaseUrl", reason: "non-loopback-http" },
    { source: "web-search.json:searchRouting:unknown-provider", reason: "unsupported-search-provider" },
  ]);

  assert.equal(storage.resolveCredential("WEB_TOOLS_TYPESAFE")?.value, "ts-test-secret-001");
  assert.equal(storage.resolveCredential("WEB_TOOLS_OPENROUTER")?.value, "or-test-secret-002");
  assert.equal(storage.resolveCredential("WEB_TOOLS_EXA")?.value, "exa-test-001,exa-test-002");
  assert.equal(storage.resolveCredential("WEB_TOOLS_TAVILY")?.value, "tvly-test-001");
  assert.equal(storage.resolveCredential("WEB_TOOLS_JINA")?.value, "jina-test-001");
  assert.equal(storage.getEffectiveSessionMode("global"), "required");

  const cfg = storage.readConfig();
  assert.equal(cfg.defaultProvider, "tavily");
  assert.deepEqual(cfg.fallbackOrder, ["exa", "jina"]);
  assert.equal(cfg.providerBaseUrls.searxng, "http://127.0.0.1:8888");
  assert.ok(cfg.outboundAuthorizations?.some((a) => a.host === "127.0.0.1" && a.port === 8888));
  assert.equal(cfg.exemptWhenNoProvider, true, "import must not rewrite an omitted policy flag");
  assert.equal(cfg.recognizeExternalWebTools, true, "import must not rewrite an omitted policy flag");
});

test("importFromPi supports object searchRouting/fetchRouting and puts http in fetchOrder while skipping tinyfish", async (t) => {
  const piDir = tempFixtureDir(t, "pi-routing-obj");
  const kimiHome = tempFixtureDir(t, "kimi-routing-obj");

  fs.writeFileSync(
    path.join(piDir, "web-search.json"),
    JSON.stringify({
      exaApiKey: "exa-test-001",
      firecrawlApiKey: "fc-test-001",
      jinaApiKey: "jina-test-001",
      searchRouting: { providers: ["brave", "exa", "tavily", "jina", "tinyfish"] },
      fetchRouting: { providers: ["exa", "http", "firecrawl", "jina", "tinyfish"] },
    }),
  );

  const storage = new LocalStorage(path.join(kimiHome, "web-tools"));
  storage.ensureDir();
  storage.writeConfig({ exemptWhenNoProvider: false, recognizeExternalWebTools: false });

  const view = await importFromPi(
    {
      readConfig: () => storage.readConfig() as unknown as Record<string, unknown>,
      writeConfig: async (patch) => {
        storage.writeConfig(patch);
      },
      readCredential: async (ref) => {
        const res = storage.resolveCredential(ref);
        return { value: res?.source === "local" ? res.value : undefined };
      },
      writeCredential: async (ref, value) => {
        storage.setCredential(ref, value);
      },
    },
    { piDir },
  );

  assert.deepEqual(view.importedRouting, { defaultProvider: "brave", fallbackOrder: ["exa", "tavily", "jina"] });
  assert.deepEqual(view.importedFetchOrder, ["exa", "http", "firecrawl", "jina"]);
  assert.deepEqual(view.skipped, [
    { source: "web-search.json:searchRouting:tinyfish", reason: "unsupported-search-provider" },
    { source: "web-search.json:fetchRouting:tinyfish", reason: "unsupported-fetch-provider" },
  ]);

  const cfg = storage.readConfig();
  assert.equal(cfg.defaultProvider, "brave");
  assert.deepEqual(cfg.fallbackOrder, ["exa", "tavily", "jina"]);
  assert.deepEqual(cfg.fetchOrder, ["exa", "http", "firecrawl", "jina"]);
  assert.equal(cfg.exemptWhenNoProvider, false, "import must preserve an explicit false policy");
  assert.equal(cfg.recognizeExternalWebTools, false, "import must preserve an explicit false policy");
});

test("bin/import-pi.mjs CLI writes credentials & smart mode from Pi dir cleanly", (t) => {
  const piDir = tempFixtureDir(t, "pi-cli");
  const kimiHome = tempFixtureDir(t, "kimi-cli");
  fs.writeFileSync(path.join(piDir, "auth.json"), JSON.stringify({ typesafe: { type: "api_key", key: "ts-cli-secret" } }));
  fs.writeFileSync(path.join(piDir, "search-mode.json"), JSON.stringify({ mode: "smart" }));

  const res = spawnSync(process.execPath, [path.join(ROOT, "bin", "import-pi.mjs"), "--pi-dir", piDir], {
    env: { ...process.env, KIMI_CODE_HOME: kimiHome },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes("ts-cli-secret"), "CLI stdout must never leak key");
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.importedSmartProviders, ["typesafe"]);
  assert.equal(parsed.importedMode, "smart");

  const storage = new LocalStorage(path.join(kimiHome, "web-tools"));
  assert.equal(storage.resolveCredential("WEB_TOOLS_TYPESAFE")?.value, "ts-cli-secret");
  assert.equal(storage.getEffectiveSessionMode("global"), "smart");
});

test("/web-tools/api/import/pi route invokes importPi dependency", async () => {
  let handler: any;
  const server = {
    register(route: any) {
      handler = route.handler;
      return () => {};
    },
  };
  registerRoutes(
    { webServer: server as any } as any,
    {
      readConfig: () => ({}),
      writeConfig: async () => {},
      readCredential: async () => ({ configured: false, writable: true }),
      writeCredential: async () => {},
      testProviderSearch: async () => ({}),
      testFullSearch: async () => ({}),
      describeQuotas: async () => ({}),
      nativeRuntime: {} as any,
      sourceRegistry: new SpecializedSourceRegistry(),
      importPi: async () => ({
        piDir: "/tmp/pi",
        importedSearchProviders: ["exa"],
        importedSmartProviders: ["typesafe"],
        importedBaseUrls: [],
        importedMode: "smart",
        skipped: [],
      }),
    },
  );
  const req = {
    url: `${API_PREFIX}/import/pi`,
    method: "POST",
    headers: { host: "127.0.0.1:18492" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield "{}";
    },
  };
  let statusCode = 0;
  let body = "";
  const res = {
    statusCode: 200,
    writeHead(s: number) {
      statusCode = s;
    },
    end(b: string) {
      body = b;
    },
  };
  await handler(req, res);
  assert.equal(statusCode, 200, body);
  const json = JSON.parse(body);
  assert.equal(json.ok, true);
  assert.deepEqual(json.value.importedSearchProviders, ["exa"]);
  assert.deepEqual(json.value.importedSmartProviders, ["typesafe"]);
  assert.equal(json.value.importedMode, "smart");
});

test("importFromPi keeps the existing fallbackOrder when Pi only supplies defaultProvider", async (t) => {
  const piDir = tempFixtureDir(t, "pi-default-only");
  const kimiHome = tempFixtureDir(t, "kimi-default-only");
  fs.writeFileSync(path.join(piDir, "web-search.json"), JSON.stringify({ defaultProvider: "exa" }));

  const storage = new LocalStorage(path.join(kimiHome, "web-tools"));
  storage.ensureDir();
  storage.writeConfig({ defaultProvider: "brave", fallbackOrder: ["tavily", "jina"] });

  const view = await importFromPi(
    {
      readConfig: () => storage.readConfig() as unknown as Record<string, unknown>,
      writeConfig: async (patch) => {
        storage.writeConfig(patch);
      },
      readCredential: async () => ({ value: undefined }),
      writeCredential: async () => {},
    },
    { piDir },
  );

  assert.deepEqual(view.importedRouting, { defaultProvider: "exa" });
  const cfg = storage.readConfig();
  assert.equal(cfg.defaultProvider, "exa");
  assert.deepEqual(cfg.fallbackOrder, ["tavily", "jina"], "a bare defaultProvider must not wipe the existing fallback chain");
});
