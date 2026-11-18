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
  if (response && typeof response === "object") {
    if (response.isError === true || response.is_error === true || response.ok === false) return false;
  }
  return true;
}

async function main() {
  const payload = await hookPayload();
  const failed = payload.hook_event_name === "PostToolUseFailure" || !receiptSucceeded(payload);
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const baseDir = webToolsDir();
  const modeStatePath = path.join(baseDir, "mode-state.json");

  // Own-tool completion is authoritative in the gateway. A second receipt here
  // cannot identify the parent turn of an isolated subagent and must not guess.
  const ownKind = classifyOwnTool(payload.tool_name);
  if (ownKind) return;

  const input =
    payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {};
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
    entry.turn.externalWebCompleted = true;
    if (!failed) {
      entry.turn.externalWebSucceeded = true;
    } else if (entry.turn.externalWebSucceeded === undefined) {
      entry.turn.externalWebSucceeded = false;
    }
    if (kind === "search") {
      entry.turn.externalSearchCompleted = true;
      if (!failed) {
        entry.turn.externalSearchSucceeded = true;
      } else if (entry.turn.externalSearchSucceeded === undefined) {
        entry.turn.externalSearchSucceeded = false;
      }
    }
    entry.updatedAt = Date.now();
  });
}

main().catch(() => {});
