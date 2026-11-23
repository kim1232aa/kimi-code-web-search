import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CURRENT_VERSION, compareVersions } from "../src/shared/version.ts";
import { RELEASES_API, RELEASES_URL } from "../src/host/index.ts";
import { safeHttpUrl, throwIfHttp, type ProviderError } from "../src/host/providers/types.ts";
import { parseJinaSearchJson } from "../src/host/providers/jina.ts";
import { parseParallelSearchResults } from "../src/host/providers/parallel.ts";
import { parseKeenableSearchJson } from "../src/host/providers/keenable.ts";
import { SearxngProvider } from "../src/host/providers/searxng.ts";

test("version comparison accepts v-prefixed semantic versions", () => {
  assert.equal(compareVersions("v0.2.1", "0.2.0"), 1);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.99"), 1);
});

test("shipped version stays in sync with package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(CURRENT_VERSION, pkg.version);
});

test("release URLs point to kim1232aa/kimi-code-web-search", () => {
  assert.equal(RELEASES_API, "https://api.github.com/repos/kim1232aa/kimi-code-web-search/releases/latest");
  assert.equal(RELEASES_URL, "https://github.com/kim1232aa/kimi-code-web-search/releases");
});

test("safeHttpUrl rejects javascript:/data:/file: URLs across built-in parsers", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), undefined);
  assert.equal(safeHttpUrl("data:text/html,<script>1</script>"), undefined);
  assert.equal(safeHttpUrl("file:///etc/passwd"), undefined);
  assert.equal(safeHttpUrl("https://example.com/a"), "https://example.com/a");

  assert.deepEqual(
    parseJinaSearchJson({ data: [{ url: "javascript:alert(1)" }, { url: "https://example.com/ok" }] }, 5),
    [{ url: "https://example.com/ok" }],
  );
  assert.deepEqual(
    parseParallelSearchResults({ results: [{ url: "javascript:void(0)" }, { url: "https://example.com/ok" }] }, 5),
    [{ url: "https://example.com/ok" }],
  );
  assert.deepEqual(
    parseKeenableSearchJson({ results: [{ url: "data:text/plain,x" }, { url: "https://example.com/ok" }] }, 5),
    [{ url: "https://example.com/ok" }],
  );
});

test("throwIfHttp and SearxngProvider cancel error body and classify 402/408/429", async () => {
  let cancelled = 0;
  const makeErrRes = (status: number, headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
      { status, headers },
    );

  assert.throws(
    () => throwIfHttp("Test", makeErrRes(500)),
    (err: unknown) => (err as ProviderError).code === "server",
  );
  assert.equal(cancelled, 1);

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => makeErrRes(429, { "retry-after": "7" })) as typeof globalThis.fetch;
    await assert.rejects(
      () => SearxngProvider.search("q", 5, "", "http://127.0.0.1:8080"),
      (err: unknown) => (err as ProviderError).code === "rate-limit" && (err as ProviderError).retryAfterMs === 7000,
    );

    globalThis.fetch = (async () => makeErrRes(408)) as typeof globalThis.fetch;
    await assert.rejects(
      () => SearxngProvider.search("q", 5, "", "http://127.0.0.1:8080"),
      (err: unknown) => (err as ProviderError).code === "timeout",
    );

    globalThis.fetch = (async () => makeErrRes(402)) as typeof globalThis.fetch;
    await assert.rejects(
      () => SearxngProvider.search("q", 5, "", "http://127.0.0.1:8080"),
      (err: unknown) => (err as ProviderError).code === "quota",
    );
    assert.equal(cancelled, 4);
  } finally {
    globalThis.fetch = origFetch;
  }
});
