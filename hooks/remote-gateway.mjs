import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webToolsDir, updateModeState } from "./mode-state.mjs";

const VALID_MODES = new Set(["auto", "smart", "required", "off"]);

export function parseGatewayUrl(raw, label = "KIMI_WEB_TOOLS_GATEWAY_URL") {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not embed credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain a query string or fragment`);
  }
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${url.origin}${basePath}`;
}

export function stripBom(text) {
  return typeof text === "string" ? text.replace(/^\uFEFF/, "") : "";
}

function readJsonObject(filePath, { throwOnParseError = false, label = path.basename(filePath) } = {}) {
  if (!fs.existsSync(filePath)) return undefined;
  let parsed;
  try {
    const raw = stripBom(fs.readFileSync(filePath, "utf8"));
    parsed = JSON.parse(raw);
  } catch (error) {
    if (throwOnParseError) {
      throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (throwOnParseError) {
      throw new Error(`Invalid ${label}: expected a JSON object`);
    }
    return undefined;
  }
  return parsed;
}

function defaultPluginRoot(env) {
  const fromEnv = typeof env?.KIMI_PLUGIN_ROOT === "string" ? env.KIMI_PLUGIN_ROOT.trim() : "";
  if (fromEnv) return fromEnv;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveBaseDir(options, env) {
  const explicit = typeof options.kimiCodeHome === "string" ? options.kimiCodeHome.trim() : "";
  if (explicit) return path.join(explicit, "web-tools");
  const fromEnv = typeof env?.KIMI_CODE_HOME === "string" ? env.KIMI_CODE_HOME.trim() : "";
  if (fromEnv) return path.join(fromEnv, "web-tools");
  return webToolsDir();
}

/**
 * Resolve remote gateway configuration shared by the stdio MCP bridge and all
 * client lifecycle hooks.
 *
 * Precedence:
 *  1. `KIMI_WEB_TOOLS_GATEWAY_URL` env var (an explicit empty string forces local mode).
 *  2. `$KIMI_CODE_HOME/web-tools/remote.json` (`{ "url", "token", "syncMode?", "sendContext?" }`).
 *  3. `<pluginRoot>/kimi.plugin.json` -> `mcpServers.s.env` (compatibility fallback
 *     when desktop clients store env vars in the plugin manifest, since Kimi only
 *     passes `mcpServers.*.env` to MCP servers and not to hooks).
 */
export function resolveRemoteGateway(options = {}) {
  const env = options.env ?? process.env;
  const envToken = typeof env?.KIMI_WEB_TOOLS_GATEWAY_TOKEN === "string"
    ? env.KIMI_WEB_TOOLS_GATEWAY_TOKEN.trim()
    : "";

  if (env && Object.hasOwn(env, "KIMI_WEB_TOOLS_GATEWAY_URL")) {
    const raw = typeof env.KIMI_WEB_TOOLS_GATEWAY_URL === "string" ? env.KIMI_WEB_TOOLS_GATEWAY_URL.trim() : "";
    if (!raw) return undefined;
    return {
      url: parseGatewayUrl(raw, "KIMI_WEB_TOOLS_GATEWAY_URL"),
      token: envToken,
      syncMode: true,
      sendContext: true,
      source: "env",
    };
  }

  const baseDir = resolveBaseDir(options, env);
  const remoteFile = path.join(baseDir, "remote.json");
  const remoteConfig = readJsonObject(remoteFile, { throwOnParseError: true, label: "remote.json" });
  if (remoteConfig) {
    if (remoteConfig.url !== undefined && typeof remoteConfig.url !== "string") {
      throw new Error("remote.json url must be a string");
    }
    const raw = typeof remoteConfig.url === "string" ? remoteConfig.url.trim() : "";
    if (!raw) return undefined;
    const fileToken = typeof remoteConfig.token === "string" ? remoteConfig.token.trim() : "";
    return {
      url: parseGatewayUrl(raw, "remote.json url"),
      token: envToken || fileToken,
      syncMode: remoteConfig.syncMode !== false,
      sendContext: remoteConfig.sendContext !== false,
      source: "remote-json",
    };
  }

  const pluginRoot = options.pluginRoot ?? defaultPluginRoot(env);
  const manifest = readJsonObject(path.join(pluginRoot, "kimi.plugin.json"));
  const serverEnv = manifest?.mcpServers?.s?.env;
  if (serverEnv && typeof serverEnv === "object" && !Array.isArray(serverEnv)) {
    const raw = typeof serverEnv.KIMI_WEB_TOOLS_GATEWAY_URL === "string"
      ? serverEnv.KIMI_WEB_TOOLS_GATEWAY_URL.trim()
      : "";
    if (raw) {
      const manifestToken = typeof serverEnv.KIMI_WEB_TOOLS_GATEWAY_TOKEN === "string"
        ? serverEnv.KIMI_WEB_TOOLS_GATEWAY_TOKEN.trim()
        : "";
      return {
        url: parseGatewayUrl(raw, "KIMI_WEB_TOOLS_GATEWAY_URL"),
        token: envToken || manifestToken,
        syncMode: true,
        sendContext: true,
        source: "manifest",
      };
    }
  }

  return undefined;
}

export function safeResolveRemoteGateway(options = {}) {
  try {
    return resolveRemoteGateway(options);
  } catch (error) {
    process.stderr.write(`Kimi Web Tools remote gateway config ignored: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

/**
 * Mirror remote gateway mode state into the client's local `mode-state.json`
 * without clobbering active turn tracking fields.
 */
export function applyRemoteModeToDoc(doc, result) {
  if (!doc || !result || typeof result !== "object") return;
  const globalMode = VALID_MODES.has(result.globalMode) ? result.globalMode : undefined;
  const effective = VALID_MODES.has(result.mode) ? result.mode : undefined;
  const hasExplicitOverrideField = Object.hasOwn(result, "sessionModeOverride");
  const override = VALID_MODES.has(result.sessionModeOverride) ? result.sessionModeOverride : undefined;
  const sid = typeof result.sessionId === "string" && result.sessionId.trim() ? result.sessionId.trim() : "global";

  if (globalMode) {
    doc.globalMode = globalMode;
  }
  if (sid === "global" || sid === "default") return;

  const current = Object.hasOwn(doc.sessions, sid) ? doc.sessions[sid] : undefined;
  if (hasExplicitOverrideField) {
    if (override) {
      Object.defineProperty(doc.sessions, sid, {
        value: { ...(current ?? {}), mode: override, updatedAt: Date.now() },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else if (current && Object.hasOwn(current, "mode")) {
      const next = { ...current, updatedAt: Date.now() };
      delete next.mode;
      Object.defineProperty(doc.sessions, sid, {
        value: next,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return;
  }

  if (effective) {
    if (effective !== doc.globalMode) {
      Object.defineProperty(doc.sessions, sid, {
        value: { ...(current ?? {}), mode: effective, updatedAt: Date.now() },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else if (current && Object.hasOwn(current, "mode")) {
      const next = { ...current, updatedAt: Date.now() };
      delete next.mode;
      Object.defineProperty(doc.sessions, sid, {
        value: next,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}

export function syncRemoteModeToLocal(result, modeStatePath = path.join(webToolsDir(), "mode-state.json")) {
  if (!result || typeof result !== "object") return;
  try {
    updateModeState(modeStatePath, (doc) => {
      applyRemoteModeToDoc(doc, result);
    });
  } catch {
    // Best-effort local cache mirror; never fail the primary MCP call.
  }
}
