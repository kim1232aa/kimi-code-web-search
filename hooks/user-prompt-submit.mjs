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
  return [
    searchOnly
      ? "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Only a search call satisfies this turn — reading a URL alone does not count (`web_mode`/`web_status` do not count)."
      : "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. A search or a URL read satisfies this turn (`web_mode`/`web_status` do not count).",
    "Before drafting, pick out the facts your answer will rest on — versions, docs/APIs, commands, config keys, errors, URLs, dates (on coding tasks: the libraries and commands you use) — and search each with a query that names the claim (the product, API, or error), not a paraphrase of the request.",
    "If results miss the point, are thin, or conflict: rewrite the query and switch `provider` (1–2 others, never `all`) or use another web tool; never retry a provider that failed. Unsure of a URL, tool parameter, or command flag? Search for it first — don't guess and retry.",
    "Search snippets are leads: read the primary source (official docs, source, release notes) with `web_fetch` and cite what you read.",
    "未搜到不等于不存在: if evidence is missing or conflicting, say so and mark it 未验证 — never fill gaps from memory (不凭记忆补全).",
  ].join("\n");
}

const PLATFORM_SEARCH_TEXT = [
  "To target a platform, use exactly one routing prefix such as 小红书: or X:; do not repeat the platform name as a topic keyword.",
  "The provider removes that routing prefix before entering the platform search box.",
].join("\n");

const SEARCH_DISABLED_TEXT =
  "Web search is switched OFF for this session. Do not call web_search or web_fetch; answer strictly from existing context. If fresh web data or unverified external claims are needed, mark them as 未验证 instead of guessing from memory.";

const SEARCH_AUTO_TEXT =
  "Web search is available but not required. Call web_search (or web_fetch for a specific URL) for current facts, versions/docs/APIs, unknown entities, or errors; otherwise answer directly from context. When searching, do not retry a failing provider — switch via `provider` to cross-verify gaps/conflicts, read primary sources via `web_fetch`, and mark unsupported claims as 未验证.";

const SMART_AUTO_TEXT =
  "[Smart Mode: Auto] The smart classifier determined that local or general context is sufficient, or classification was unavailable (fail-open). Web search is not required, but still search on demand for external docs/APIs/versions/URLs or uncertain claims; read primary sources via `web_fetch`, switch `provider` instead of retrying errors, and mark unverified claims as 未验证.";

const NO_WEB_ROUTE_INSTRUCTION =
  "No usable kimi-code-web-search search route is available for this turn; mandatory web-search enforcement is exempted. If no other web tool is available, answer strictly from existing context and locally verified files/tests, never claim web verification was performed, and mark unverified external facts as 未验证.";

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

  const platforms = cfg.platformEnabled ?? { xiaohongshu: true, x: true };
  const platformsEnabled = platforms.xiaohongshu !== false || platforms.x !== false;
  const recognizeExternal = !configExists || cfg.recognizeExternalWebTools !== false;
  const searchOnly = turnState.requiredEvidence === "search";
  const turnBinding = `Pass session_id="${sessionId}" and turn_id=${turnState.turn} when calling web_search or web_fetch (also include them in a subagent prompt if delegating required web_search/web_fetch; explore/plan subagents have built-in WebSearch/FetchURL but not this plugin's MCP tools).`;
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
    const baseText = platformsEnabled ? `${requiredText}\n${PLATFORM_SEARCH_TEXT}` : requiredText;
    const smartText = mode === "smart" ? "[Smart Mode: Escalated to Required Web Search]\n" : "";
    process.stdout.write(`${smartText}${baseText}${routeHint}\n${turnBinding}\n`);
  }
}

main().catch(hookFailure);
