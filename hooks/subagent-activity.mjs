#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

// Kimi hook payloads carry no agent identity, and the Stop hook fires for every
// agent scope with the shared session_id. SubagentStart/SubagentStop are the
// only lifecycle signals available; a failed or cancelled subagent never fires
// SubagentStop, so the counter is also reset when a new user turn begins.
async function main() {
  const payload = await hookPayload();
  const event = payload.hook_event_name;
  if (event !== "SubagentStart" && event !== "SubagentStop") return;
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  updateModeState(path.join(webToolsDir(), "mode-state.json"), (doc) => {
    const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
    const current = Number(entry.activeSubagents ?? 0) || 0;
    const next = event === "SubagentStart" ? current + 1 : Math.max(0, current - 1);
    Object.defineProperty(doc.sessions, sessionId, {
      value: { ...entry, activeSubagents: next, updatedAt: Date.now() },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });
}

main().catch(hookFailure);
