#!/usr/bin/env node
/**
 * kimi-code-web-search — Stdio JSON-RPC 2.0 MCP Server for Kimi Code.
 *
 * Implements MCP protocol over stdin/stdout:
 *  - Connects to a configured remote gateway or starts the local daemon for search and fetch only.
 *  - Exposes 4 tools:
 *    1. `web_search` — Multi-provider web search
 *    2. `web_fetch`  — Full-page content extraction
 *    3. `web_mode`   — View or switch Search Mode (`auto`, `smart`, `required`, `off`)
 *    4. `web_status` — List search engines that can actually run a query
 */
import readline from "node:readline";
import { ensureGatewayDaemon, probeLocalGateway } from "./gateway-daemon.mjs";
import { positiveInteger } from "../hooks/mode-state.mjs";
import { formatUsableEngines } from "../hooks/usable-engines.mjs";

const VERSION = "0.4.0";
const PROTOCOL_VERSION = "2025-06-18";

function requestSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "global";
}

function optionalPositiveInteger(value) {
  try {
    return positiveInteger(value, "turn_id");
  } catch {
    return undefined;
  }
}

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web through the configured multi-provider routing chain (Exa, Tavily, Brave, You.com, Firecrawl, Parallel, Jina, Keenable, SearXNG, custom sources).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        max_results: {
          type: ["integer", "string"],
          minimum: 1,
          maximum: 20,
          pattern: "^[1-9][0-9]*$",
          description: "Maximum number of results to return (default: 8, max: 20).",
        },
        provider: {
          type: "string",
          description: "Optional configured provider name or custom source ID to override routing for cross-verification.",
        },
        session_id: {
          type: "string",
          description: "Optional session identifier.",
        },
        turn_id: {
          type: ["integer", "string"],
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          pattern: "^[1-9][0-9]*$",
          description: "Optional turn identifier injected by UserPromptSubmit hook.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch and extract clean readable text/Markdown from a web URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The HTTP/HTTPS URL to fetch and extract content from.",
        },
        session_id: {
          type: "string",
          description: "Optional session identifier.",
        },
        turn_id: {
          type: ["integer", "string"],
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          pattern: "^[1-9][0-9]*$",
          description: "Optional turn identifier injected by UserPromptSubmit hook.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_mode",
    description:
      "Get, set, or toggle the Web Search Mode (`auto` = 智能联网, `smart` = Jev 判定, `required` = 始终联网, `off` = 关闭联网) for the current session or globally.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set", "toggle"],
          description: "Operation to perform: `get` (default), `set`, or `toggle`.",
        },
        mode: {
          type: "string",
          enum: ["auto", "smart", "required", "off"],
          description: "Target mode when action is `set` (`auto`, `smart`, `required`, or `off`).",
        },
        session_id: {
          type: "string",
          description: "Target session ID, or `global` (default) to configure the global default mode.",
        },
      },
    },
  },
  {
    name: "web_status",
    description: "List search engines that can actually run a query (configured key or explicit self-hosted instance).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional session ID. Ignored; status is gateway-wide.",
        },
      },
    },
  },
];

/**
 * Where this plugin's tool calls go. `KIMI_WEB_TOOLS_GATEWAY_URL` points at a
 * gateway running somewhere else (this machine or another); when it is unset
 * the plugin uses the local gateway and starts it only for retrieval.
 */
function configuredGateway() {
  const raw = process.env.KIMI_WEB_TOOLS_GATEWAY_URL?.trim();
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("KIMI_WEB_TOOLS_GATEWAY_URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("KIMI_WEB_TOOLS_GATEWAY_URL must be an http(s) URL");
  }
  if (url.username || url.password) {
    throw new Error("KIMI_WEB_TOOLS_GATEWAY_URL must not embed credentials");
  }
  if (url.search || url.hash) {
    throw new Error("KIMI_WEB_TOOLS_GATEWAY_URL must not contain a query string or fragment");
  }
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return { url: `${url.origin}${basePath}`, token: process.env.KIMI_WEB_TOOLS_GATEWAY_TOKEN?.trim() || "" };
}

async function callGatewayMcp(endpoint, payload, timeoutMs = 90_000) {
  const configured = configuredGateway();
  const retrieve = endpoint === "search" || endpoint === "fetch";
  const gw = configured ?? await (retrieve ? ensureGatewayDaemon() : probeLocalGateway());
  if (!gw) {
    throw new Error("Local gateway is not running. Start it explicitly for local use, or set KIMI_WEB_TOOLS_GATEWAY_URL for remote use.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const headers = { "content-type": "application/json" };
    if (configured?.token) headers.authorization = `Bearer ${configured.token}`;
    let res, text;
    try {
      res = await fetch(`${gw.url}/web-tools/mcp/${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (error) {
      const reason = controller.signal.aborted ? "request timed out" : "connection or response failed";
      throw new Error(`${configured ? "Remote" : "Local"} gateway ${gw.url}: ${reason}.`, { cause: error });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from gateway (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || parsed?.ok === false) {
      throw new Error(parsed?.error?.message || `Gateway HTTP ${res.status}`);
    }
    return parsed.value;
  } finally {
    clearTimeout(timer);
  }
}

function formatSearchOutput(value) {
  const sources = Array.isArray(value?.sources) ? value.sources : [];
  const headerParts = [`Query: ${value?.query ?? ""}`];
  if (value?.backend) headerParts.push(`Provider: ${value.backend}`);
  if (typeof value?.latencyMs === "number") headerParts.push(`Latency: ${value.latencyMs}ms`);
  headerParts.push(`Results: ${sources.length}`);

  if (sources.length === 0) {
    return `${headerParts.join(" | ")}\n\nNo results found.`;
  }

  const items = sources.map((s, idx) => {
    const lines = [`[${idx + 1}] ${s.title || s.url}`];
    lines.push(`URL: ${s.url}`);
    if (s.publishedAt) lines.push(`Published: ${s.publishedAt}`);
    if (s.snippet) lines.push(`Snippet: ${s.snippet}`);
    return lines.join("\n");
  });

  return `${headerParts.join(" | ")}\n\n${items.join("\n\n")}`;
}

function formatFetchOutput(value) {
  const header = `URL: ${value?.url ?? ""}\nStatus: ${value?.statusCode ?? 200}${
    typeof value?.latencyMs === "number" ? ` | Latency: ${value.latencyMs}ms` : ""
  }${value?.truncated ? " | Truncated: true" : ""}`;
  const content = value?.body?.content ?? "";
  return `${header}\n\n${content}`;
}

function formatModeOutput(value) {
  const modeNames = {
    auto: "auto (智能联网 — model decides when to search)",
    smart: "smart (Jev 判定 — Jev classifier decides per turn whether lookup is required)",
    required: "required (始终联网 — at least one web_search required per turn)",
    off: "off (关闭联网 — web tools disabled and blocked)",
  };
  return [
    `Session: ${value?.sessionId ?? "global"}`,
    `Effective Mode: ${modeNames[value?.mode] || value?.mode}`,
    `Global Default Mode: ${modeNames[value?.globalMode] || value?.globalMode}`,
    `Search Provider Available: ${value?.available ? "yes" : "no"}`,
  ].join("\n");
}

function formatStatusOutput(value) {
  return formatUsableEngines(value);
}

async function runTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const sessionId = requestSessionId(args.session_id ?? args.sessionId);
  try {
    const rawTurnId = Object.hasOwn(args, "turn_id") ? args.turn_id : args.turnId;
    const turnId = optionalPositiveInteger(rawTurnId);
    if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("Missing required argument: query");
      const maxResults = positiveInteger(Object.hasOwn(args, "max_results") ? args.max_results : args.maxResults, "max_results", 20) ?? 8;
      if (args.provider !== undefined && typeof args.provider !== "string") throw new Error("provider must be a string");
      const result = await callGatewayMcp("search", { query, maxResults, provider: args.provider, sessionId, turnId });
      return { content: [{ type: "text", text: formatSearchOutput(result) }] };
    }

    if (name === "web_fetch") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("Missing required argument: url");
      const result = await callGatewayMcp("fetch", { url, sessionId, turnId });
      return { content: [{ type: "text", text: formatFetchOutput(result) }] };
    }

    if (name === "web_mode") {
      const targetSession = args.session_id ?? args.sessionId ?? "global";
      const action = args.action ?? (args.mode ? "set" : "get");
      const result = await callGatewayMcp("mode", {
        sessionId: targetSession,
        action,
        mode: args.mode,
        updateGlobal: targetSession === "global",
      });
      return { content: [{ type: "text", text: formatModeOutput(result) }] };
    }

    if (name === "web_status") {
      const result = await callGatewayMcp("status", { sessionId });
      return { content: [{ type: "text", text: formatStatusOutput(result) }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

async function handleRequest(message) {
  const { method, id, params } = message;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "kimi-code-web-search", version: VERSION },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return runTool(params);
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.jsonRpc = { code: -32601, message: `Method not found: ${method}`, data: { id } };
      throw err;
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (message.jsonrpc !== "2.0") {
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Invalid Request" } });
    }
    return;
  }
  if (message.id === undefined || message.id === null) return;
  const id = message.id;
  if (typeof message.method !== "string") {
    send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  try {
    const result = await handleRequest(message);
    send({ jsonrpc: "2.0", id, result: result ?? {} });
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      error: err?.jsonRpc ?? {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function start() {
  process.stdin.on("error", () => {});
  // The host can close our stdout mid-shutdown while a response is still in
  // flight; a lost pipe is a normal exit, not an unhandled crash.
  process.stdout.on("error", (err) => {
    if (err?.code === "EPIPE") process.exit(0);
  });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return;
    }
    void dispatch(message);
  });
}

start();
