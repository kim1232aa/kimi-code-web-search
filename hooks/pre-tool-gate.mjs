#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  effectiveMode,
  classifyOwnTool,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

const WEB_DISABLED_DENIAL =
  "Web search is switched OFF for this session, so this tool call was denied. Answer from the existing context and state what could not be verified.";

async function main() {
  const payload = await hookPayload();
  const kind = classifyOwnTool(payload.tool_name);
  if (!kind) {
    return;
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const modeStatePath = path.join(webToolsDir(), "mode-state.json");
  let blocked = false;

  updateModeState(modeStatePath, (doc) => {
    const mode = effectiveMode(doc, sessionId);
    if (mode === "off") {
      blocked = true;
      return;
    }

    const currentEntry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
    const pendingTools = Array.isArray(currentEntry.pendingTools) ? [...currentEntry.pendingTools] : [];
    pendingTools.push(`${kind}:${payload.tool_call_id || Date.now()}`);
    doc.activeSessionId = sessionId;
    Object.defineProperty(doc.sessions, sessionId, {
      value: {
        ...currentEntry,
        pendingTools: pendingTools.slice(-20),
        updatedAt: Date.now(),
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  if (blocked) {
    process.stderr.write(WEB_DISABLED_DENIAL);
    process.exitCode = 2;
  }
}

main().catch(hookFailure);
