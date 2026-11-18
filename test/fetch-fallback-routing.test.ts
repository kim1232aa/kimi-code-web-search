import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFetchProvider, createPoolStore, type WebToolsRuntimeConfig } from "../src/host/registry.ts";
import type { ProviderAdapterLike } from "../src/host/registry.ts";
import { GenericFetchError, type GenericFetchResult } from "../src/host/generic-fetch.ts";

function stubConfig(overrides: Partial<WebToolsRuntimeConfig> = {}): WebToolsRuntimeConfig {
  return {
    enabled: true,
    defaultProvider: "searxng",
    providerAttemptTimeoutMs: 5000,
    fallbackOrder: ["searxng", "brave", "tavily"],
    providerBaseUrls: {},
    enabledProviders: { searxng: true, brave: true, tavily: true },
    ...overrides,
  };
}

describe("fetch fallback routing: Native -> Generic fallback", () => {
  it("reports available = true for SearXNG-only or Brave-only setups (Issue #5 fix)", () => {
    const searxngConfig = stubConfig({ defaultProvider: "searxng", fallbackOrder: ["searxng"] });
    const fetchProvider = createFetchProvider(() => searxngConfig, async () => "");
    assert.equal(fetchProvider.available(), true);

    const braveConfig = stubConfig({ defaultProvider: "brave", fallbackOrder: ["brave"] });
    const braveFetchProvider = createFetchProvider(() => braveConfig, async () => "");
    assert.equal(braveFetchProvider.available(), true);
  });

  it("reports available = false when plugin is disabled in config", () => {
    const disabledConfig = stubConfig({ enabled: false });
    const fetchProvider = createFetchProvider(() => disabledConfig, async () => "");
    assert.equal(fetchProvider.available(), false);
  });

  it("uses native fetch provider (e.g. Tavily/Exa) directly when available and healthy", async () => {
    let nativeCalled = false;
    let genericCalled = false;

    const mockAdapters: Record<string, ProviderAdapterLike> = {
      tavily: {
        name: "tavily",
        needsBaseUrl: false,
        fetchCapable: true,
        async search() { return { sources: [] }; },
        async fetch(url: string) {
          nativeCalled = true;
          return { text: "Extracted by Tavily native API" };
        },
      },
    };

    const config = stubConfig({
      defaultProvider: "tavily",
      fallbackOrder: ["tavily"],
    });

    const mockGeneric = async (): Promise<GenericFetchResult> => {
      genericCalled = true;
      return {
        url: "https://example.com",
        finalUrl: "https://example.com",
        statusCode: 200,
        contentType: "text/html",
        content: "Built-in content",
        truncated: false,
        backend: "builtin-http",
        extraction: "defuddle",
      };
    };

    const fetchProvider = createFetchProvider(
      () => config,
      async () => "tavily-key-1",
      mockAdapters,
      undefined,
      undefined,
      mockGeneric,
    );

    const res = await fetchProvider.fetch({ url: "https://example.com/article" });
    assert.equal(nativeCalled, true);
    assert.equal(genericCalled, false);
    assert.equal(res.body.content, "Extracted by Tavily native API");
    assert.equal(res.backend, "tavily");
  });

  it("falls back to generic fetch when default search provider is non-fetch-capable (SearXNG / Brave)", async () => {
    let genericCalled = false;

    const mockAdapters: Record<string, ProviderAdapterLike> = {
      searxng: {
        name: "searxng",
        needsBaseUrl: true,
        fetchCapable: false,
        async search() { return { sources: [] }; },
        async fetch() { throw new Error("not implemented"); },
      },
    };

    const config = stubConfig({
      defaultProvider: "searxng",
      fallbackOrder: ["searxng"],
    });

    const mockGeneric = async (url: string): Promise<GenericFetchResult> => {
      genericCalled = true;
      return {
        url,
        finalUrl: url,
        statusCode: 200,
        contentType: "text/html",
        title: "SearXNG Fallback Article",
        author: "OpenSource Dev",
        publishedAt: "2026-04-12",
        content: "Extracted via builtin Defuddle",
        truncated: false,
        backend: "builtin-http",
        extraction: "defuddle",
      };
    };

    const fetchProvider = createFetchProvider(
      () => config,
      async () => "",
      mockAdapters,
      undefined,
      undefined,
      mockGeneric,
    );

    const res = await fetchProvider.fetch({ url: "https://example.com/docs" });
    assert.equal(genericCalled, true);
    assert.equal(res.backend, "builtin-http");
    assert.equal(res.body.content, "Extracted via builtin Defuddle");
    assert.equal(res.metadata?.title, "SearXNG Fallback Article");
    assert.equal(res.metadata?.author, "OpenSource Dev");
  });

  it("falls back to generic fetch when native fetch provider fails with retryable error (e.g. 500 / network)", async () => {
    let genericCalled = false;

    const mockAdapters: Record<string, ProviderAdapterLike> = {
      exa: {
        name: "exa",
        needsBaseUrl: false,
        fetchCapable: true,
        async search() { return { sources: [] }; },
        async fetch() {
          const err: any = new Error("Exa server 500");
          err.code = "server";
          throw err;
        },
      },
    };

    const config = stubConfig({
      defaultProvider: "exa",
      fallbackOrder: ["exa"],
    });

    const mockGeneric = async (url: string): Promise<GenericFetchResult> => {
      genericCalled = true;
      return {
        url,
        finalUrl: url,
        statusCode: 200,
        contentType: "text/html",
        content: "Fallback content after Exa failure",
        truncated: false,
        backend: "builtin-http",
        extraction: "defuddle",
      };
    };

    const fetchProvider = createFetchProvider(
      () => config,
      async () => "exa-key",
      mockAdapters,
      undefined,
      undefined,
      mockGeneric,
    );

    const res = await fetchProvider.fetch({ url: "https://example.com/failed-native" });
    assert.equal(genericCalled, true);
    assert.equal(res.backend, "builtin-http");
    assert.equal(res.body.content, "Fallback content after Exa failure");
  });

  it("supports custom fetchOrder placing builtin http between native providers (Exa -> HTTP -> Firecrawl -> Jina)", async () => {
    const calls: string[] = [];
    const adapters: Record<string, ProviderAdapterLike> = {
      exa: {
        name: "exa",
        needsBaseUrl: false,
        fetchCapable: true,
        async search() { return { sources: [] }; },
        async fetch() {
          calls.push("exa");
          throw Object.assign(new Error("Exa 500"), { code: "server" });
        },
      },
      firecrawl: {
        name: "firecrawl",
        needsBaseUrl: false,
        fetchCapable: true,
        async search() { return { sources: [] }; },
        async fetch() {
          calls.push("firecrawl");
          return { text: "Firecrawl extracted markdown" };
        },
      },
      jina: {
        name: "jina",
        needsBaseUrl: false,
        fetchCapable: true,
        async search() { return { sources: [] }; },
        async fetch() {
          calls.push("jina");
          return { text: "Jina extracted markdown" };
        },
      },
    };

    const config = stubConfig({
      defaultProvider: "brave",
      fallbackOrder: ["exa"],
      fetchOrder: ["exa", "http", "firecrawl", "jina"],
      enabledProviders: { exa: true, firecrawl: true, jina: true },
    });

    // Case 1: exa fails transiently, builtin http succeeds -> firecrawl & jina are never called
    let httpOk = true;
    const provider = createFetchProvider(
      () => config,
      async () => "test-key",
      adapters,
      undefined,
      undefined,
      async (url: string): Promise<GenericFetchResult> => {
        calls.push("http");
        if (!httpOk) {
          throw new GenericFetchError("WEB_HTTP_ERROR", "HTTP 403 Forbidden", { statusCode: 403, url });
        }
        return {
          url,
          finalUrl: url,
          statusCode: 200,
          contentType: "text/html",
          content: "HTTP content",
          truncated: false,
          backend: "builtin-http",
          extraction: "defuddle",
        };
      },
    );

    const res1 = await provider.fetch({ url: "https://example.org/doc" });
    assert.deepEqual(calls, ["exa", "http"]);
    assert.equal(res1.backend, "builtin-http");

    // Case 2: exa fails, builtin http returns 403 -> falls forward to firecrawl
    calls.length = 0;
    httpOk = false;
    const res2 = await provider.fetch({ url: "https://example.org/protected" });
    assert.deepEqual(calls, ["exa", "http", "firecrawl"]);
    assert.equal(res2.backend, "firecrawl");
    assert.equal(res2.body.content, "Firecrawl extracted markdown");
  });

  it("aborts immediately on SSRF / blocked URL in builtin http even when Firecrawl/Jina follow in fetchOrder", async () => {
    const calls: string[] = [];
    const adapters: Record<string, ProviderAdapterLike> = {
      firecrawl: {
        name: "firecrawl",
        needsBaseUrl: false,
        fetchCapable: true,
        async search() { return { sources: [] }; },
        async fetch() {
          calls.push("firecrawl");
          return { text: "must not reach firecrawl" };
        },
      },
    };
    const config = stubConfig({
      fetchOrder: ["http", "firecrawl"],
      enabledProviders: { firecrawl: true },
    });
    const provider = createFetchProvider(
      () => config,
      async () => "test-key",
      adapters,
      undefined,
      undefined,
      async (url: string): Promise<GenericFetchResult> => {
        calls.push("http");
        throw new GenericFetchError("WEB_FETCH_BLOCKED", "Private IP blocked", { url });
      },
    );

    await assert.rejects(provider.fetch({ url: "http://127.0.0.1/secret" }), /Private IP blocked/);
    assert.deepEqual(calls, ["http"]);
  });

  it("does not append builtin HTTP when an explicit fetch order omits it", async () => {
    const calls: string[] = [];
    const provider = createFetchProvider(
      () => stubConfig({
        fetchOrder: ["exa"],
        enabledProviders: { exa: true },
      }),
      async () => "test-key",
      {
        exa: {
          name: "exa",
          needsBaseUrl: false,
          fetchCapable: true,
          async search() { return { sources: [] }; },
          async fetch() {
            calls.push("exa");
            throw Object.assign(new Error("Exa unavailable"), { code: "server" });
          },
        },
      },
      undefined,
      undefined,
      async () => {
        calls.push("http");
        throw new Error("explicit fetch order must not call builtin HTTP");
      },
    );

    await assert.rejects(provider.fetch({ url: "https://example.org/doc" }), /Exa unavailable/);
    assert.deepEqual(calls, ["exa"]);
  });

  it("propagates final provider error when intermediate builtin http fails in explicit fetchOrder", async () => {
    const calls: string[] = [];
    const provider = createFetchProvider(
      () => stubConfig({
        fetchOrder: ["http", "firecrawl"],
        enabledProviders: { firecrawl: true },
      }),
      async () => "test-key",
      {
        firecrawl: {
          name: "firecrawl",
          needsBaseUrl: false,
          fetchCapable: true,
          async search() { return { sources: [] }; },
          async fetch() {
            calls.push("firecrawl");
            throw Object.assign(new Error("Firecrawl 503 Service Unavailable"), { code: "unavailable" });
          },
        },
      },
      undefined,
      undefined,
      async (url: string): Promise<GenericFetchResult> => {
        calls.push("http");
        throw new GenericFetchError("WEB_HTTP_ERROR", "HTTP 403 Forbidden", { statusCode: 403, url });
      },
    );

    const err = await assert.rejects(
      provider.fetch({ url: "https://example.org/doc" }),
      (e: any) => e.message.includes("Firecrawl 503") || e.code === "unavailable",
    );
    assert.deepEqual(calls, ["http", "firecrawl"]);
  });

  it("stops the chain and does not fall back to builtin http when a native fetch provider fails with non-retryable error", async () => {
    const calls: string[] = [];
    const provider = createFetchProvider(
      () => stubConfig({
        defaultProvider: "exa",
        fallbackOrder: [],
        fetchOrder: [],
        enabledProviders: { exa: true },
      }),
      async () => "test-key",
      {
        exa: {
          name: "exa",
          needsBaseUrl: false,
          fetchCapable: true,
          async search() { return { sources: [] }; },
          async fetch() {
            calls.push("exa");
            throw Object.assign(new Error("Bad Request: invalid query parameters"), { code: "bad-request" });
          },
        },
      },
      undefined,
      undefined,
      async () => {
        calls.push("http");
        return {
          url: "https://example.org/doc",
          finalUrl: "https://example.org/doc",
          statusCode: 200,
          contentType: "text/html",
          content: "should not be called",
          truncated: false,
          backend: "builtin-http",
          extraction: "defuddle",
        };
      },
    );

    await assert.rejects(
      provider.fetch({ url: "https://example.org/doc" }),
      /Bad Request/i,
    );
    assert.deepEqual(calls, ["exa"], "non-retryable native error must stop the chain without trying builtin http");
  });
});
