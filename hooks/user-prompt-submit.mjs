#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  webToolsDir,
  readModeState,
  updateModeState,
  effectiveMode,
  newTurn,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";
import {
  extractPromptInput,
  classifySmartTurn,
  usableSearchRoutes,
} from "./smart-classifier.mjs";

function requiredSearchText(searchOnly) {
  return searchOnly
    ? "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Any web search counts — this plugin's `web_search`, your built-in `WebSearch`, or another search MCP (`exa`, `tavily`, `brave`, ...). Reading a URL alone does not count (`web_mode`/`web_status` do not count)."
    : "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Any web search or page read counts — this plugin's tools, your built-in `WebSearch`/`FetchURL`, or another search MCP. (`web_mode`/`web_status` do not count.)";
}

const SEARCH_DISABLED_TEXT =
  "Web search is switched OFF for this session. Do not call web_search or web_fetch; answer strictly from existing context. If fresh web data or unverified external claims are needed, mark them as 未验证 instead of guessing from memory.";

const SEARCH_AUTO_TEXT =
  "Web search is available but not required. Call any available web search — this plugin's `web_search`, your built-in `WebSearch`, or another search MCP — for current facts, versions/docs/APIs, unknown entities, or errors; otherwise answer directly from context. When searching, do not retry a failing provider — switch source to cross-verify gaps/conflicts, read primary sources via `web_fetch`/`FetchURL`, and mark unsupported claims as 未验证.";

const SMART_AUTO_TEXT =
  "[Smart Mode: Auto] The smart classifier determined that local or general context is sufficient, or classification was unavailable (fail-open). Web search is not required, but still search on demand for external docs/APIs/versions/URLs or uncertain claims; read primary sources via `web_fetch`, switch `provider` instead of retrying errors, and mark unverified claims as 未验证.";

const NO_WEB_ROUTE_INSTRUCTION =
  "No usable route for this plugin's own web search was found this turn, so mandatory enforcement is exempted. You may still use your built-in `WebSearch`/`FetchURL` or any other search MCP; never claim web verification that did not happen, and mark unverified external facts as 未验证.";

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

async function main() {
  const payload = await hookPayload();
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const { text: promptText, hasImages } = extractPromptInput(payload.prompt);

  const baseDir = webToolsDir();
  const kimiCodeHome = path.dirname(baseDir);
  const modeStatePath = path.join(baseDir, "mode-state.json");
  const configPath = path.join(baseDir, "config.json");
  const configExists = fs.existsSync(configPath);
  const cfg = configExists ? readJsonFile(configPath, {}) : {};
  const creds = readJsonFile(path.join(baseDir, "credentials.json"), {});
  const platformStates = Object.fromEntries(["xiaohongshu", "x"].map((platform) => [
    platform,
    readJsonFile(path.join(baseDir, "browser-profiles", platform, "dsh-profile-meta.json"), {}),
  ]));

  let mode = effectiveMode(readModeState(modeStatePath), sessionId);

  const routes = usableSearchRoutes(cfg, creds, platformStates, kimiCodeHome, process.env);
  const exempted = mode !== "off" && configExists && (cfg.enabled === false ||
    (cfg.exemptWhenNoProvider !== false && routes.webProviders.length === 0 && routes.platforms.length === 0));
  const isSteer = payload.is_steer === true || payload.isSteer === true;

  let turnState;
  if (isSteer) {
    const doc = readModeState(modeStatePath);
    const existingTurn = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId]?.turn : undefined;
    if (existingTurn) {
      turnState = existingTurn;
    }
  }

  let decision;
  if (!turnState && mode === "smart" && !exempted) {
    try {
      decision = await classifySmartTurn({ promptText, hasImages, sessionId, kimiCodeHome, config: cfg, credentials: creds });
    } catch (err) {
      // classifySmartTurn only throws when smartSearch.failOpen === false:
      // honor fail-closed by escalating this turn instead of degrading to auto.
      const failClosed = cfg.smartSearch?.failOpen === false;
      decision = {
        ok: false,
        escalated: failClosed,
        fallbackReason: err?.reason || "network-error",
        error: failClosed
          ? "Smart classifier unavailable; failing closed to required web search for this turn."
          : "Smart classifier unavailable; continuing in auto mode.",
      };
    }
  }

  if (!turnState) {
    updateModeState(modeStatePath, (doc) => {
      mode = effectiveMode(doc, sessionId);
      const smartDecision = mode === "smart" && decision
        ? { ...decision, mode: decision.escalated ? "required" : "auto", at: Date.now() }
        : undefined;
      turnState = newTurn(doc, sessionId, {
        required: !exempted && (mode === "required" || (mode === "smart" && Boolean(smartDecision?.escalated))),
        requiredEvidence: cfg.requiredEvidence === "search-or-fetch" ? "search-or-fetch" : "search",
        exempted,
        smartEscalated: Boolean(smartDecision?.escalated),
        smartDecision,
      });
      if (smartDecision) doc.sessions[sessionId].lastSmartDecision = smartDecision;
      doc.activeSessionId = sessionId;
    });
  }

  const recognizeExternal = !configExists || cfg.recognizeExternalWebTools !== false;
  const searchOnly = turnState.requiredEvidence === "search";
  const turnBinding = `Any search path counts. If you use this plugin's own tools, pass session_id="${sessionId}" and turn_id=${turnState.turn} (also include them in a subagent prompt when delegating); built-in WebSearch/FetchURL and other search MCP tools count without them.`;
  const hintParts = [];
  if (configExists && routes.webProviders.length > 0) {
    hintParts.push(`Ready search providers (for web_search provider=...): ${routes.webProviders.join(", ")}.`);
  }
  if (recognizeExternal) {
    hintParts.push(searchOnly
      ? "Recognized external web search tools also satisfy this turn."
      : "Recognized external web tools also satisfy this turn.");
  }
  const routeHint = hintParts.length > 0 ? `\n${hintParts.join(" ")}` : "";

  if (mode === "off") {
    process.stdout.write(`${SEARCH_DISABLED_TEXT}\n`);
  } else if (exempted) {
    process.stdout.write(`${NO_WEB_ROUTE_INSTRUCTION}\n`);
  } else if (turnState.required) {
    const requiredText = requiredSearchText(searchOnly);
    const smartText = mode === "smart" ? "[Smart Mode: Escalated to Required Web Search]\n" : "";
    process.stdout.write(`${smartText}${requiredText}${routeHint}\n${turnBinding}\n`);
  }
}

main().catch(hookFailure);
