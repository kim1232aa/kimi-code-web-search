/**
 * kimi-code-web-search — package & plugin manifest contract tests.
 *
 * Verifies:
 *  - `package.json` declares `kimi-code-web-search` v0.4.0 (`type: "module"`) with zero
 *    `@deepseek-ai/*` dependencies or peerDependencies.
 *  - `kimi.plugin.json` declares the `s` MCP server (`./bin/mcp-server.mjs`) under plugin `web`,
 *    the lifecycle hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`),
 *    `./commands/`, `./skills/`, and `./SYSTEM.md`.
 *  - `dist/client/app.js` (once built) is completely self-contained and never
 *    references `@deepseek-ai/*`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zhDict, enDict } from "../src/client/i18n-dict.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const readPkg = () =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;

const readPluginManifest = () =>
  JSON.parse(readFileSync(join(root, "kimi.plugin.json"), "utf8")) as Record<string, any>;

test("package.json declares kimi-code-web-search 0.4.0 with zero @deepseek-ai/* dependencies", () => {
  const pkg = readPkg();
  assert.equal(pkg.name, "kimi-code-web-search");
  assert.equal(pkg.version, "0.4.0");
  assert.equal(pkg.type, "module");

  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  for (const name of Object.keys(allDeps)) {
    assert.ok(!name.startsWith("@deepseek-ai/"), `must not depend on ${name}`);
  }
  for (const required of ["defuddle", "linkedom", "undici"]) {
    assert.ok(Object.hasOwn(pkg.dependencies ?? {}, required), `missing dependency ${required}`);
  }
  for (const buildOnly of ["react", "react-dom"]) {
    assert.ok(Object.hasOwn(pkg.devDependencies ?? {}, buildOnly), `missing devDependency ${buildOnly}`);
    assert.ok(!Object.hasOwn(pkg.dependencies ?? {}, buildOnly), `${buildOnly} is bundled into dist/client and should stay in devDependencies`);
  }
  assert.ok(!Object.hasOwn(allDeps, "ws") && !Object.hasOwn(allDeps, "@types/ws"), "unused ws dependency must be removed");
});

test("kimi.plugin.json declares MCP server, hooks, commands, skills, and SYSTEM.md", () => {
  const manifest = readPluginManifest();
  assert.equal(manifest.name, "web");
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.commands, "./commands/");
  assert.equal(manifest.systemPromptPath, "./SYSTEM.md");
  assert.equal(manifest.mcpServers?.s?.command, "node");
  assert.deepEqual(manifest.mcpServers?.s?.args, ["./bin/mcp-server.mjs"]);

  const preHook = (manifest.hooks ?? []).find((h: any) => h.event === "PreToolUse");
  assert.ok(preHook, "missing PreToolUse hook");
  const preRe = new RegExp(preHook.matcher);
  for (const name of [
    "web_search",
    "web_fetch",
    "mcp__plugin-web_s__web_search",
    "mcp__plugin-web_s__web_fetch",
    "mcp__plugin-kimi-web-tools_s__web_search",
    "mcp__plugin-kimi-code-web-search_web__web_fetch",
  ]) {
    assert.ok(preRe.test(name), `PreToolUse matcher must match ${name}`);
  }
  for (const name of [
    "mcp__plugin-web_s__web_mode",
    "mcp__plugin-web_s__web_status",
    "mcp__exa__web_search",
    "FetchURL",
    "Read",
  ]) {
    assert.ok(!preRe.test(name), `PreToolUse matcher must skip ${name}`);
  }

  const events = (manifest.hooks ?? []).map((h: any) => h.event);
  assert.deepEqual(events, [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "TurnStarted",
    "SessionEnd",
    "Stop",
  ]);
});

test("PostToolUse prefilter covers every recognized web tool and skips local tools", () => {
  const manifest = readPluginManifest();
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    const hook = (manifest.hooks ?? []).find((h: any) => h.event === event);
    assert.ok(hook, `missing ${event} hook`);
    assert.equal(typeof hook.matcher, "string", `${event} must declare a matcher to avoid spawning a process per tool call`);
    const re = new RegExp(hook.matcher);
    for (const name of [
      // this plugin's own MCP tools
      "web_search",
      "web_fetch",
      "mcp__plugin-web_s__web_search",
      "mcp__plugin-web_s__web_fetch",
      "mcp__plugin-kimi-code-web-search_web__web_search",
      "mcp__plugin-kimi-code-web-search_web__web_fetch",
      // Kimi built-ins
      "FetchURL",
      "WebSearch",
      // exact external names recognized by the receipt hook
      "SearchWeb",
      "websearch",
      "webfetch",
      "search_web",
      "fetch_web",
      "fetch_content",
      "fetch_url",
      "fetch_urls",
      "fetch_markdown",
      "fetch_webpage",
      "read_url",
      "read_website",
      "web_url_read",
      "source_check",
      "get_page_text",
      // MCP proxies and vendor tools
      "mcp",
      "mcp__agy_websearch",
      "tavily-search",
      "firecrawl_scrape",
      "brave_web_search",
      "mcp__exa__web_search_exa",
      "mcp__perplexity__perplexity_ask",
      "mcp__fetch__fetch",
      "mcp__serpapi__search",
      "agy-websearch_search_web",
    ]) {
      assert.ok(re.test(name), `${event} matcher must match ${name}`);
    }
    for (const name of ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoList", "TaskList", "TaskOutput", "NotifyUser", "Skill", "Agent", "CronCreate", "WaitFor"]) {
      assert.ok(!re.test(name), `${event} matcher must skip local tool ${name}`);
    }
  }
});

test("built dist/client/app.js never references @deepseek-ai/* packages", () => {
  const bundlePath = join(root, "dist", "client", "app.js");
  if (!existsSync(bundlePath)) return;
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(!bundle.includes("@deepseek-ai/"), "client bundle must not reference @deepseek-ai/*");
});

test("build config & manifest parity: version matches, host build excludes client, i18n keys balanced", () => {
  const pkg = readPkg();
  const manifest = readPluginManifest();
  assert.equal(pkg.version, manifest.version, "package.json and kimi.plugin.json versions must match");
  assert.ok(!String(pkg.description ?? "").includes("social platform research"), "stale description must be removed");
  assert.ok(String(pkg.scripts?.["build:host"] ?? "").includes("rmSync('lib'"), "build:host must clean lib/ before tsc");

  const tsconfigBuild = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8")) as { include?: string[] };
  assert.deepEqual(tsconfigBuild.include, ["src/host/**/*.ts", "src/shared/**/*.ts"]);

  const zhKeys = new Set(Object.keys(zhDict));
  const enKeys = new Set(Object.keys(enDict));
  assert.deepEqual([...zhKeys].filter((k) => !enKeys.has(k)), [], "zhDict has keys missing from enDict");
  assert.deepEqual([...enKeys].filter((k) => !zhKeys.has(k)), [], "enDict has keys missing from zhDict");
  for (const key of ["searxngDefaultHint", "apiKeyConfigured", "httpMethod", "manage"]) {
    assert.ok(zhKeys.has(key) && enKeys.has(key), `missing i18n key ${key}`);
  }
});
