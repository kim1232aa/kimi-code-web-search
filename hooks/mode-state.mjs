import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const modes = new Set(["auto", "smart", "required", "off"]);
// A lock created via openSync("wx") is written a moment later; empty locks
// younger than this are assumed to be mid-creation, not orphaned.
const EMPTY_LOCK_GRACE_MS = 10_000;

function syncDirQuietly(dir) {
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms (e.g. Windows); the
    // file-level fsync above already covers the truncation risk.
  }
}

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be a positive integer${maximum === Number.MAX_SAFE_INTEGER ? "" : ` between 1 and ${maximum}`}`);
  }
  return number;
}

export function webToolsDir() {
  return path.join(process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), ".kimi-code"), "web-tools");
}

export function readModeState(file = path.join(webToolsDir(), "mode-state.json")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { globalMode: "auto", sessions: {}, updatedAt: Date.now() };
    throw error;
  }
  const doc = JSON.parse(raw);
  if (!doc || !modes.has(doc.globalMode) || !doc.sessions || typeof doc.sessions !== "object" || Array.isArray(doc.sessions)) {
    throw new Error(`Invalid mode-state document: ${file}`);
  }
  for (const [id, entry] of Object.entries(doc.sessions)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || (entry.mode !== undefined && !modes.has(entry.mode))) {
      throw new Error(`Invalid mode-state session: ${id}`);
    }
  }
  return doc;
}

export function updateModeState(file, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (fd !== undefined) {
          fs.closeSync(fd);
          fs.unlinkSync(lock);
        }
        throw error;
      }
      try {
        const before = fs.statSync(lock);
        const raw = fs.readFileSync(lock, "utf8");
        const pid = Number(raw);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (probeError) {
            if (probeError.code === "ESRCH") {
              const current = fs.statSync(lock);
              if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
                try {
                  fs.unlinkSync(lock);
                } catch (unlinkError) {
                  if (unlinkError.code !== "ENOENT") throw unlinkError;
                }
                process.stderr.write(`Kimi Web Tools: reclaimed mode-state lock owned by exited PID ${pid}\n`);
              }
              continue;
            }
            if (probeError.code !== "EPERM") throw probeError;
          }
        } else if (Date.now() - before.mtimeMs > EMPTY_LOCK_GRACE_MS) {
          // Empty or malformed lock content: the creator died between openSync
          // and the PID write. After a grace period it can never be released
          // by its owner, so reclaim it (double-checked via inode + mtime).
          const current = fs.statSync(lock);
          if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
            try {
              fs.unlinkSync(lock);
            } catch (unlinkError) {
              if (unlinkError.code !== "ENOENT") throw unlinkError;
            }
            process.stderr.write(`Kimi Web Tools: reclaimed unowned mode-state lock (no valid PID, age ${(Date.now() - before.mtimeMs) / 1000 | 0}s)\n`);
            continue;
          }
        }
      } catch (readError) {
        if (readError.code !== "ENOENT") throw readError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out updating mode-state: ${file}`);
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
  }
  let temporary;
  try {
    const doc = readModeState(file);
    change(doc);
    doc.updatedAt = Date.now();
    temporary = `${file}.${randomUUID()}.tmp`;
    const out = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
      // Durability: fsync before rename so a crash cannot leave an empty or
      // half-written mode-state behind (rename only guarantees visibility).
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(temporary, file);
    syncDirQuietly(path.dirname(file));
    temporary = undefined;
    return doc;
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function effectiveMode(doc, sessionId) {
  const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
  return sessionId === "global" || sessionId === "default" ? doc.globalMode : (entry?.mode ?? doc.globalMode);
}

export function newTurn(doc, sessionId, options) {
  const mode = effectiveMode(doc, sessionId);
  const previous = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
  // Backstop cleanup for sessions that never fired SessionEnd (crash, kill):
  // turn state is ephemeral runtime data, while an explicit mode override is
  // user intent. Only entries without an override and older than 30 days go.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(doc.sessions)) {
    if (id === sessionId || typeof entry?.mode === "string") continue;
    const at = Number(entry?.updatedAt ?? 0);
    if (!Number.isFinite(at) || at < cutoff) delete doc.sessions[id];
  }
  const turn = {
    turn: (previous.turn?.turn ?? 0) + 1,
    required: options?.required ?? (mode === "required"), disabled: mode === "off",
    requiredEvidence: options?.requiredEvidence === "search-or-fetch" ? "search-or-fetch" : "search",
    exempted: Boolean(options?.exempted), smartEscalated: Boolean(options?.smartEscalated),
    smartDecision: options?.smartDecision, externalWebCompleted: false,
    externalSearchCompleted: false,
    webSearchCompleted: false, webSearchSucceeded: false,
    webFetchCompleted: false, webFetchSucceeded: false, correctionCount: 0,
  };
  Object.defineProperty(doc.sessions, sessionId, {
    value: { ...previous, turn, pendingTools: [], activeSubagents: 0, systemTurnPending: false, updatedAt: Date.now() },
    writable: true, enumerable: true, configurable: true,
  });
  return turn;
}

export function classifyOwnTool(name) {
  if ([
    "web_search",
    "mcp__web__web_search",
    "mcp__plugin-web_s__web_search",
    "mcp__plugin-kimi-code-web-search_web__web_search",
  ].includes(name)) return "web_search";
  if ([
    "web_fetch",
    "mcp__web__web_fetch",
    "mcp__plugin-web_s__web_fetch",
    "mcp__plugin-kimi-code-web-search_web__web_fetch",
  ].includes(name)) return "web_fetch";
  return undefined;
}

const NON_WEB_TOOLS = new Set(["web_enable", "get_search_content", "select_tools", "web_mode", "web_status", "fetch_logs"]);
const EXACT_EXTERNAL_WEB_TOOLS = new Set([
  "fetchurl",
  "searchweb",
  "websearch",
  "webfetch",
  "web_search",
  "web_fetch",
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
]);

const WEB_VENDOR_TOKENS = new Set([
  "exa", "tavily", "firecrawl", "perplexity", "jina", "duckduckgo", "ddg", "searxng", "kagi", "linkup", "serper", "serpapi", "brave",
]);
const WEB_VENDOR_ACTION_TOKENS = new Set(["search", "fetch", "scrape", "crawl", "crawling", "extract", "reader", "ask", "research", "reason"]);
const NON_WEB_ACTION_TOKENS = new Set(["feedback", "status", "credit", "usage", "monitor"]);

function normalizeToolSegment(name) {
  return name.toLowerCase().replace(/[-.\s]+/g, "_").replace(/^_+|_+$/g, "");
}

export function isMcpProxyToolName(name) {
  return typeof name === "string" && (name === "mcp" || (name.startsWith("mcp__") && name.indexOf("__", 5) === -1));
}

export function isExternalWebToolName(name) {
  if (typeof name !== "string" || !name.trim() || classifyOwnTool(name)) return false;
  let server = "";
  let tool = "";
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__").filter(Boolean);
    if (parts.length >= 2) {
      server = normalizeToolSegment(parts[0]);
      tool = normalizeToolSegment(parts.slice(1).join("__"));
    } else {
      tool = normalizeToolSegment(parts[0] ?? "");
    }
  } else {
    tool = normalizeToolSegment(name);
  }
  if (!tool || NON_WEB_TOOLS.has(tool)) return false;
  const toolTokens = tool.split("_");
  if (toolTokens.some((token) => NON_WEB_ACTION_TOKENS.has(token))) return false;
  if (/(?:^|_)(?:git_fetch|credit_usage|monitor_(?:delete|list|create|update)|file_search|code_search|grep_search|symbol_search|workspace_search|memory_search|db_search|vector_search|repo_search)(?:_|$)/.test(tool)) {
    return false;
  }
  if (EXACT_EXTERNAL_WEB_TOOLS.has(tool)) return true;
  if (
    /(?:^|_)web_?search(?:_|$)/.test(tool) ||
    /(?:^|_)search_?web(?:_|$)/.test(tool) ||
    /(?:^|_)web_?fetch(?:_|$)/.test(tool) ||
    /(?:^|_)fetch_?(?:content|url|urls|web|webpage|markdown)(?:_|$)/.test(tool) ||
    /(?:^|_)source_?check(?:_|$)/.test(tool) ||
    /(?:^|_)(?:tavily|firecrawl|perplexity|jina|duckduckgo|ddg|searxng|kagi|linkup|serper|brave)_(?:search|news_search|web_search|extract|scrape|crawl|fetch|reader|ask|research|llm_context)(?:_|$)/.test(tool) ||
    /(?:^|_)(?:google|bing)_search(?:_|$)/.test(tool)
  ) {
    return true;
  }
  // A known web-search vendor (as the MCP server or a name token, e.g.
  // crawling_exa, brave_image_search) doing a search/read action.
  const vendorTagged = toolTokens.some((token) => WEB_VENDOR_TOKENS.has(token)) ||
    (server && server.split("_").some((token) => WEB_VENDOR_TOKENS.has(token)));
  if (vendorTagged && toolTokens.some((token) => WEB_VENDOR_ACTION_TOKENS.has(token))) {
    return true;
  }
  if (
    server &&
    /^(?:fetch|search|scrape|extract)$/.test(tool) &&
    /(?:^|_)(?:web|fetch|fetcher|scrape|scraper|search|browse|crawl|exa|jina|tavily|firecrawl|brave|perplexity|searxng|duckduckgo|ddg|kagi|linkup|serper|serpapi|google|bing|agy_websearch)(?:_|$)/.test(server)
  ) {
    return true;
  }
  return false;
}

export function isExternalWebToolCall(name, input) {
  if (typeof name !== "string" || !name.trim() || classifyOwnTool(name)) return false;
  if (isMcpProxyToolName(name)) {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const innerTool = typeof record.tool === "string" ? record.tool.trim()
      : typeof record.tool_name === "string" ? record.tool_name.trim() : "";
    if (!innerTool || isMcpProxyToolName(innerTool)) return false;
    return Boolean(classifyOwnTool(innerTool)) || isExternalWebToolName(innerTool);
  }
  return isExternalWebToolName(name);
}

function presentValue(value) {
  return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

const SEARCH_NAME_TOKENS = new Set(["ask", "research", "reason"]);
const READ_NAME_TOKENS = new Set(["fetch", "read", "scrape", "crawl", "crawling", "extract", "reader", "url", "page", "content", "markdown", "webpage"]);

function nameTokens(tool) {
  if (typeof tool !== "string") return "";
  const raw = tool.startsWith("mcp__")
    ? (() => { const parts = tool.slice(5).split("__").filter(Boolean); return parts.length >= 2 ? parts.slice(1).join("__") : parts[0] ?? ""; })()
    : tool;
  return normalizeToolSegment(raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2"));
}

function kindFromName(bare) {
  if (/(?:^|_)llm_context(?:_|$)/.test(bare)) return "search";
  const tokens = bare.split("_");
  if (tokens.some((token) => token.includes("search") || SEARCH_NAME_TOKENS.has(token))) return "search";
  if (tokens.some((token) => READ_NAME_TOKENS.has(token))) return "fetch";
  return undefined;
}

function targetsUrl(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (presentValue(input.url) || presentValue(input.urls)) return true;
  const query = input.query ?? input.q;
  return typeof query === "string" && /^https?:\/\/\S+$/i.test(query.trim());
}

function hasQuery(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return ["query", "q", "queries", "search_query", "searchQuery", "objective"].some((key) => presentValue(input[key]));
}

/**
 * Whether a recognized external web call performed a search or read a page.
 * A URL target always means a page read, even on a search-named tool; the
 * name decides next (search/ask/research/reason/llm_context -> search;
 * fetch/read/scrape/crawl/extract -> read). Only an ambiguous name falls back
 * to the arguments, so a query argument never promotes a read tool to search.
 */
export function externalWebToolKind(name, input) {
  if (!isExternalWebToolCall(name, input)) return undefined;
  let tool = name;
  let args = input;
  if (isMcpProxyToolName(name)) {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    tool = typeof record.tool === "string" ? record.tool.trim()
      : typeof record.tool_name === "string" ? record.tool_name.trim() : "";
    const own = classifyOwnTool(tool);
    if (own) return own === "web_search" ? "search" : "fetch";
    args = [record.args, record.arguments, record.input, record.params]
      .find((value) => value && typeof value === "object" && !Array.isArray(value));
  }
  if (targetsUrl(args)) return "fetch";
  return kindFromName(nameTokens(tool)) ?? (hasQuery(args) ? "search" : "fetch");
}

export async function hookPayload() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

export function hookFailure(error) {
  console.error(`Kimi Web Tools mode-state error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
