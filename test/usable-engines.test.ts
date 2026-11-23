import test from "node:test";
import assert from "node:assert/strict";
import { formatUsableEngines, usableSearchEngines } from "../hooks/usable-engines.mjs";

test("usable engines prefer the slim usable list", () => {
  assert.deepEqual(usableSearchEngines({ usable: ["exa", "brave"] }), ["exa", "brave"]);
  assert.equal(formatUsableEngines({ usable: ["exa"] }), "Usable search engines: exa");
});

test("legacy provider rows count only engines that can actually search", () => {
  const names = usableSearchEngines({
    gateway: { url: "http://127.0.0.1:18492", pid: 1 },
    providers: [
      { name: "exa", enabled: true, keyConfigured: true },
      { name: "brave", enabled: true, keyConfigured: false },
      { name: "searxng", enabled: true, keyConfigured: false, baseUrlConfigured: false },
      { name: "custom", enabled: true, needsBaseUrl: true, baseUrlConfigured: true },
      { name: "tavily", enabled: false, keyConfigured: true },
    ],
  });
  assert.deepEqual(names, ["exa", "custom"]);
  assert.equal(formatUsableEngines({ providers: [] }), "Usable search engines: (none)");
});
