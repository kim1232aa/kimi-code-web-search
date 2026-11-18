#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

// Kimi starts turns without a user prompt (background task notifications,
// goal continuations). Their Stop must not be steered by the previous user
// turn's research requirement, so mark the session and let the Stop gate
// skip exactly one turn-end. A new user prompt clears the marker.
async function main() {
  const payload = await hookPayload();
  if (payload.origin_kind !== "system_trigger") return;
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  updateModeState(path.join(webToolsDir(), "mode-state.json"), (doc) => {
    const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
    Object.defineProperty(doc.sessions, sessionId, {
      value: { ...entry, systemTurnPending: true, updatedAt: Date.now() },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });
}

main().catch(hookFailure);
