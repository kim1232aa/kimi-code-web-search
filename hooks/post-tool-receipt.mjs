#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  classifyOwnTool,
  externalWebToolKind,
  hookPayload,
} from "./mode-state.mjs";

// Kimi fires PostToolUseFailure only when the tool result sets isError; some
// MCP servers return provider failures (HTTP 403, quota) as plain text. A
// multi-source answer is split on markdown headings and counts as failed only
// when every section is an error, so one failing source among others is fine.
const ERROR_PREFIX = /^(?:error|exception)(?:\s*[:(\[]|\s+(?:fetching|calling|executing)\b)|^\{\s*"error"\s*:|^tool "[^"]*" not found/;

function looksLikeErrorText(output) {
  const sections = output.split(/^[ \t]*#{1,6}[ \t][^\n]*$/m)
    .map((section) => section.trim().toLowerCase())
    .filter(Boolean);
  return sections.length > 0 && sections.every((section) => ERROR_PREFIX.test(section));
}

function receiptSucceeded(payload) {
  if (payload.hook_event_name === "PostToolUseFailure") return false;
  if (payload.error) return false;
  const output = payload.tool_output;
  if (typeof output === "string" && looksLikeErrorText(output)) return false;
  const response = payload.tool_response;
  if (typeof response === "string" && looksLikeErrorText(response)) return false;
  if (response && typeof response === "object") {
    if (response.isError === true || response.is_error === true || response.ok === false) return false;
    if (Array.isArray(response.content)) {
      const texts = response.content
        .map((item) => (item && typeof item === "object" && typeof item.text === "string" ? item.text : ""))
        .filter((text) => text.trim().length > 0);
      if (texts.length > 0 && texts.every((text) => looksLikeErrorText(text))) return false;
    }
  }
  return true;
}

function recordOutcome(turn, completedKey, succeededKey, failed) {
  turn[completedKey] = true;
  if (!failed) {
    turn[succeededKey] = true;
  } else if (turn[succeededKey] === undefined) {
    turn[succeededKey] = false;
  }
}

async function main() {
  const payload = await hookPayload();
  const failed = payload.hook_event_name === "PostToolUseFailure" || !receiptSucceeded(payload);
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const baseDir = webToolsDir();
  const modeStatePath = path.join(baseDir, "mode-state.json");
  const input =
    payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {};

  // On a local gateway with an explicit non-global session_id, the gateway is
  // authoritative. Remote gateways cannot write local mode-state.json, and
  // omitted/"global" session_id calls skip completeTool("global", ...) locally,
  // so credit those here unless a subagent is active on local mode.
  const ownKind = classifyOwnTool(payload.tool_name);
  if (ownKind) {
    const remoteGateway = Boolean(process.env.KIMI_WEB_TOOLS_GATEWAY_URL?.trim());
    const inputSessionId =
      typeof input.session_id === "string" && input.session_id.trim()
        ? input.session_id.trim()
        : typeof input.sessionId === "string" && input.sessionId.trim()
          ? input.sessionId.trim()
          : "";
    const hasExplicitSession = Boolean(inputSessionId && inputSessionId !== "global");
    if (!remoteGateway && hasExplicitSession) return;
    if (!fs.existsSync(modeStatePath)) return;
    updateModeState(modeStatePath, (doc) => {
      const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
      if (!entry?.turn) return;
      const subagentActive = typeof entry.activeSubagents === "number" && entry.activeSubagents > 0;
      if (!remoteGateway && subagentActive) return;
      if (ownKind === "web_search") {
        recordOutcome(entry.turn, "webSearchCompleted", "webSearchSucceeded", failed);
      } else {
        recordOutcome(entry.turn, "webFetchCompleted", "webFetchSucceeded", failed);
      }
      entry.updatedAt = Date.now();
    });
    return;
  }

  const kind = externalWebToolKind(payload.tool_name, input);
  if (!kind) return;

  const configPath = path.join(baseDir, "config.json");
  let cfg;
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return;
    }
  }
  if (cfg?.recognizeExternalWebTools === false) return;

  if (!fs.existsSync(modeStatePath)) return;
  updateModeState(modeStatePath, (doc) => {
    const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
    if (!entry?.turn) return;
    recordOutcome(entry.turn, "externalWebCompleted", "externalWebSucceeded", failed);
    if (kind === "search") {
      recordOutcome(entry.turn, "externalSearchCompleted", "externalSearchSucceeded", failed);
    }
    entry.updatedAt = Date.now();
  });
}

main().catch(() => {});
