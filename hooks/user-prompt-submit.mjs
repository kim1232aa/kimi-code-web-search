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
  extractKimiSessionContext,
  classifySmartTurn,
  usableSearchRoutes,
} from "./smart-classifier.mjs";
import {
  safeResolveRemoteGateway,
  applyRemoteModeToDoc,
  stripBom,
} from "./remote-gateway.mjs";

const VALID_MODES = new Set(["auto", "smart", "required", "off"]);

function requiredSearchText(searchOnly, recognizeExternal = true) {
  if (!recognizeExternal) {
    return searchOnly
      ? "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Use this plugin's `web_search` tool. Reading a URL alone does not count (`web_mode`/`web_status` do not count)."
      : "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Use this plugin's `web_search` or `web_fetch` tool (`web_mode`/`web_status` do not count).";
  }
  return searchOnly
    ? "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Any web search counts — this plugin's `web_search`, your built-in `WebSearch`, or another search MCP (`exa`, `tavily`, `brave`, ...). Reading a URL alone does not count (`web_mode`/`web_status` do not count)."
    : "Web Search is required for this turn: search for what the user's request actually depends on, not an arbitrary query to pass this check. Any web search or page read counts — this plugin's tools, your built-in `WebSearch`/`FetchURL`, or another search MCP. (`web_mode`/`web_status` do not count.)";
}

const SEARCH_DISABLED_TEXT =
  "Web search is switched OFF for this session. Do not call web_search or web_fetch; answer strictly from existing context. If fresh web data or unverified external claims are needed, mark them as 未验证 instead of guessing from memory.";

const NO_WEB_ROUTE_INSTRUCTION =
  "No usable route for this plugin's own web search was found this turn, so mandatory enforcement is exempted. You may still use your built-in `WebSearch`/`FetchURL` or any other search MCP; never claim web verification that did not happen, and mark unverified external facts as 未验证.";

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const value = JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

async function postRemoteJson(remoteGateway, endpointPath, body, timeoutMs) {
  if (timeoutMs <= 0) {
    throw new Error("Remote gateway evaluation budget exhausted");
  }
  const headers = { "content-type": "application/json" };
  if (remoteGateway.token) headers.authorization = `Bearer ${remoteGateway.token}`;
  const res = await fetch(`${remoteGateway.url}${endpointPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  return { status: res.status, ok: res.ok, parsed };
}

/**
 * Evaluate turn mode, policy flags, and (when in `smart` mode) Jev/Smart
 * classification on the remote gateway in a single round trip. Shares one
 * 9.5s total budget across primary + legacy 404 fallback so the hook always
 * finishes cleanly inside Kimi's 15s `UserPromptSubmit` timeout.
 */
async function evaluateTurnRemotely(remoteGateway, { sessionId, promptText, hasImages, isSteer, sessionContext, modeHint }) {
  const deadline = Date.now() + 9_500;
  const remainingMs = (capMs) => Math.min(capMs, deadline - Date.now());
  try {
    const primary = await postRemoteJson(
      remoteGateway,
      "/web-tools/mcp/evaluate-turn",
      { sessionId, promptText, hasImages, isSteer, sessionContext, ...(modeHint ? { modeHint } : {}) },
      remainingMs(8_500),
    );
    if (primary.ok && primary.parsed?.ok && primary.parsed.value && typeof primary.parsed.value === "object") {
      return primary.parsed.value;
    }
    if (primary.status !== 404) {
      return undefined;
    }

    // Backwards-compatible fallback for older remote gateways (pre evaluate-turn).
    const statusRes = await postRemoteJson(remoteGateway, "/web-tools/mcp/status", { sessionId }, remainingMs(2_500));
    if (!statusRes.ok || !statusRes.parsed?.ok || !statusRes.parsed.value) {
      return undefined;
    }
    const statusVal = statusRes.parsed.value;
    const modeInfo = statusVal.mode && typeof statusVal.mode === "object" ? statusVal.mode : {};
    const remoteCfg = statusVal.config && typeof statusVal.config === "object" ? statusVal.config : {};
    const mode = VALID_MODES.has(modeInfo.mode) ? modeInfo.mode : "auto";
    const globalMode = VALID_MODES.has(modeInfo.globalMode) ? modeInfo.globalMode : mode;
    const readyProviders = Array.isArray(statusVal.usable)
      ? statusVal.usable.filter((name) => typeof name === "string" && name.trim())
      : [];
    const gatewayOff = mode === "off";
    const effectiveEvalMode = gatewayOff ? "off" : (modeHint === "smart" || modeHint === "required" ? modeHint : mode);
    const canEnforce = effectiveEvalMode === "required" || effectiveEvalMode === "smart";
    const exempted = (gatewayOff && Boolean(modeHint)) || (canEnforce && (
      remoteCfg.enabled === false ||
      (remoteCfg.exemptWhenNoProvider !== false && readyProviders.length === 0)
    ));
    const effectiveReadyProviders = gatewayOff && Boolean(modeHint) ? [] : readyProviders;
    const requiredEvidence = remoteCfg.requiredEvidence === "search-or-fetch" ? "search-or-fetch" : "search";
    const recognizeExternalWebTools = remoteCfg.recognizeExternalWebTools !== false;

    let decision;
    if (!isSteer && !gatewayOff && effectiveEvalMode === "smart" && !exempted && (promptText.trim() || hasImages)) {
      const testPrompt = promptText.trim() || "Image prompt";
      const failClosed = remoteCfg.smartSearch?.failOpen === false;
      let testRes;
      try {
        testRes = await postRemoteJson(
          remoteGateway,
          "/web-tools/api/smart-classifier/test",
          { prompt: testPrompt, sessionId },
          remainingMs(5_000),
        );
      } catch {
        testRes = undefined;
      }
      if (testRes?.ok && testRes.parsed?.ok && testRes.parsed.value && typeof testRes.parsed.value === "object") {
        const val = testRes.parsed.value;
        // `/smart-classifier/test` catches exceptions and returns HTTP 200 `{ ok: false, escalated: false }`;
        // honor `failOpen: false` here so fail-closed gateways still escalate.
        decision = val.ok === false && failClosed && val.fallbackReason !== "disabled"
          ? { ...val, escalated: true }
          : val;
      } else {
        decision = {
          ok: false,
          escalated: failClosed,
          fallbackReason: "remote-gateway-error",
          error: failClosed
            ? "Remote smart classifier failed; failing closed to required web search for this turn."
            : "Remote smart classifier failed; continuing in auto mode.",
        };
      }
    }

    return {
      sessionId,
      mode,
      globalMode,
      ...(Object.hasOwn(modeInfo, "sessionModeOverride") ? { sessionModeOverride: modeInfo.sessionModeOverride } : {}),
      enabled: remoteCfg.enabled !== false,
      exemptWhenNoProvider: remoteCfg.exemptWhenNoProvider !== false,
      exempted,
      requiredEvidence,
      recognizeExternalWebTools,
      readyProviders: effectiveReadyProviders,
      ...(decision ? { decision } : {}),
    };
  } catch {
    return undefined;
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
  const remoteGateway = safeResolveRemoteGateway({ kimiCodeHome });
  const recognizeExternalDefault = !configExists || cfg.recognizeExternalWebTools !== false;

  let mode = effectiveMode(readModeState(modeStatePath), sessionId);

  const routes = usableSearchRoutes(cfg, creds, undefined, kimiCodeHome, process.env);
  const canEnforceMode = (m) => m === "required" || m === "smart";
  const isExemptedForMode = (m) =>
    canEnforceMode(m) &&
    configExists &&
    (cfg.enabled === false || (!remoteGateway && cfg.exemptWhenNoProvider !== false && routes.webProviders.length === 0));
  let exempted = isExemptedForMode(mode);
  const isSteer = payload.is_steer === true || payload.isSteer === true;

  let turnState;
  if (isSteer) {
    const doc = readModeState(modeStatePath);
    const existingTurn = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId]?.turn : undefined;
    if (existingTurn) {
      turnState = existingTurn;
    }
  }

  let remoteEvaluation;
  let decision;
  const syncMode = remoteGateway ? remoteGateway.syncMode !== false : false;
  const sendContext = remoteGateway ? remoteGateway.sendContext !== false : true;
  const shouldCallRemote = Boolean(remoteGateway && (syncMode || (canEnforceMode(mode) && !exempted)));

  if (!turnState && shouldCallRemote) {
    let sessionContext = {};
    // The classifier never runs on an empty, imageless prompt — never read
    // or transmit transcript context for one.
    if (sendContext && (promptText.trim() || hasImages) && (syncMode || mode === "smart")) {
      const extracted = extractKimiSessionContext(sessionId, kimiCodeHome);
      if (promptText.trim().length > 24 && extracted && Object.hasOwn(extracted, "prevUserText")) {
        const { prevUserText: _omitted, ...rest } = extracted;
        sessionContext = rest;
      } else {
        sessionContext = extracted;
      }
    }
    remoteEvaluation = await evaluateTurnRemotely(remoteGateway, {
      sessionId,
      promptText,
      hasImages,
      // evaluateTurnRemotely only runs when `!turnState` (initializing a fresh turn).
      isSteer: false,
      sessionContext,
      ...(!syncMode && canEnforceMode(mode) ? { modeHint: mode } : {}),
    });
    if (remoteEvaluation) {
      if (syncMode && VALID_MODES.has(remoteEvaluation.mode)) mode = remoteEvaluation.mode;
      exempted = Boolean(remoteEvaluation.exempted);
      if (remoteEvaluation.decision && typeof remoteEvaluation.decision === "object") {
        decision = remoteEvaluation.decision;
      }
    } else if (mode === "smart" && !exempted) {
      // Do not fall back to local direct classification in remote mode: the
      // client typically lacks classifier credentials or hits regional blocks.
      const failClosed = cfg.smartSearch?.failOpen === false;
      decision = {
        ok: false,
        escalated: failClosed,
        fallbackReason: "remote-gateway-error",
        error: failClosed
          ? "Remote gateway unavailable for Smart classification; failing closed to required web search for this turn."
          : "Remote gateway unavailable for Smart classification; continuing in auto mode.",
      };
    }
  } else if (!turnState && !remoteGateway && mode === "smart" && !exempted) {
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

  const effectiveRequiredEvidence = remoteEvaluation
    ? (remoteEvaluation.requiredEvidence === "search-or-fetch" ? "search-or-fetch" : "search")
    : (cfg.requiredEvidence === "search-or-fetch" ? "search-or-fetch" : "search");
  const effectiveRecognizeExternal = remoteEvaluation
    ? remoteEvaluation.recognizeExternalWebTools !== false
    : recognizeExternalDefault;

  if (!turnState) {
    updateModeState(modeStatePath, (doc) => {
      if (remoteEvaluation && syncMode) {
        applyRemoteModeToDoc(doc, remoteEvaluation);
      }
      mode = effectiveMode(doc, sessionId);
      exempted = remoteEvaluation ? Boolean(remoteEvaluation.exempted) : isExemptedForMode(mode);
      const smartDecision = mode === "smart" && decision
        ? { ...decision, mode: decision.escalated ? "required" : "auto", at: Date.now() }
        : undefined;
      turnState = newTurn(doc, sessionId, {
        required: !exempted && (mode === "required" || (mode === "smart" && Boolean(smartDecision?.escalated))),
        requiredEvidence: effectiveRequiredEvidence,
        recognizeExternal: effectiveRecognizeExternal,
        exempted,
        smartEscalated: Boolean(smartDecision?.escalated),
        smartDecision,
      });
      if (smartDecision) doc.sessions[sessionId].lastSmartDecision = smartDecision;
      doc.activeSessionId = sessionId;
    });
  }

  const recognizeExternal = turnState.recognizeExternal ?? effectiveRecognizeExternal;
  const isExempted = turnState.exempted ?? exempted;
  const searchOnly = turnState.requiredEvidence === "search";
  const turnBinding = recognizeExternal
    ? `Any search path counts. If you use this plugin's own tools, pass session_id="${sessionId}" and turn_id=${turnState.turn} (also include them in a subagent prompt when delegating); built-in WebSearch/FetchURL and other search MCP tools count without them.`
    : `Pass session_id="${sessionId}" and turn_id=${turnState.turn} to this plugin's tools (also include them in a subagent prompt when delegating).`;
  const readyProviders = remoteEvaluation
    ? (Array.isArray(remoteEvaluation.readyProviders) ? remoteEvaluation.readyProviders.filter((n) => typeof n === "string" && n.trim()) : [])
    : (!remoteGateway && configExists ? routes.webProviders : []);
  const hintParts = [];
  if (readyProviders.length > 0) {
    hintParts.push(`Ready search providers (for web_search provider=...): ${readyProviders.join(", ")}.`);
  }
  if (recognizeExternal) {
    hintParts.push(searchOnly
      ? "Recognized external web search tools also satisfy this turn."
      : "Recognized external web tools also satisfy this turn.");
  }
  const routeHint = hintParts.length > 0 ? `\n${hintParts.join(" ")}` : "";

  if (mode === "off") {
    process.stdout.write(`${SEARCH_DISABLED_TEXT}\n`);
  } else if (isExempted) {
    process.stdout.write(`${NO_WEB_ROUTE_INSTRUCTION}\n`);
  } else if (turnState.required) {
    const requiredText = requiredSearchText(searchOnly, recognizeExternal);
    const smartText = mode === "smart" ? "[Smart Mode: Escalated to Required Web Search]\n" : "";
    process.stdout.write(`${smartText}${requiredText}${routeHint}\n${turnBinding}\n`);
  }
}

main().catch(hookFailure);
