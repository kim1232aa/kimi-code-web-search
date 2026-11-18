#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

// A closed session's turn state is ephemeral runtime data. Remove it, but keep
// any explicit per-session mode override — that is user intent, not residue.
async function main() {
  const payload = await hookPayload();
  if (payload.hook_event_name !== "SessionEnd") return;
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "";
  if (!sessionId || sessionId === "global") return;
  updateModeState(path.join(webToolsDir(), "mode-state.json"), (doc) => {
    const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
    if (!entry) return;
    if (typeof entry.mode === "string") return;
    delete doc.sessions[sessionId];
  });
}

main().catch(hookFailure);
