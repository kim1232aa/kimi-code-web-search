#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  readModeState,
  updateModeState,
  effectiveMode,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

function requiredSearchCorrectionText(searchOnly) {
  const call = searchOnly ? "Call web_search" : "Call web_search or web_fetch";
  return `Web Search is required for this turn. ${call} before finalizing: search for what the user's request depends on, not an arbitrary query (\`web_mode\`/\`web_status\` do not count); mark unresolved gaps as 未验证.`;
}

const FETCH_ONLY_NOTE =
  "Reading a URL alone does not satisfy this turn — run a search for the facts your answer rests on.";

function failedResearchCorrectionText(searchOnly) {
  const what = searchOnly ? "web search" : "web lookup";
  return `Every ${what} this turn failed (errors or quota limits). Before finalizing, rewrite the query and switch \`provider\` or use another web search tool; if those fail too, answer and mark the affected claims 未验证.`;
}

const FAILED_RESEARCH_REMINDER =
  "Web research failed during this turn; state clearly what could not be verified (未验证).";

async function main() {
  const payload = await hookPayload();

  const repeatedStop = payload.stop_hook_active === true;

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const modeStatePath = path.join(webToolsDir(), "mode-state.json");

  // Kimi fires the Stop hook for every agent scope with the shared session_id
  // and no agent identity in the payload, so a subagent's turn-end cannot be
  // told apart from the main agent's. While subagents are active, stay silent
  // (fail-open, matching the DSH/Pi rule that subagents are exempt from forced
  // web search) and never consume the turn's correction budget. This check
  // runs BEFORE the system-turn marker so a subagent's Stop cannot consume it.
  const pre = readModeState(modeStatePath);
  const preEntry = pre.sessions[sessionId];
  if (typeof preEntry?.activeSubagents === "number" && preEntry.activeSubagents > 0) {
    return;
  }

  // System-trigger turns (background task notifications, goal continuations)
  // have no user prompt and must not inherit the previous user turn's research
  // requirement. Consume the marker set by TurnStarted and skip this turn-end.
  if (preEntry?.systemTurnPending === true) {
    updateModeState(modeStatePath, (doc) => {
      const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
      if (!entry) return;
      Object.defineProperty(doc.sessions, sessionId, {
        value: { ...entry, systemTurnPending: false, updatedAt: Date.now() },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });
    return;
  }

  let shouldSteer = false;
  let turnId;
  let failedResearch = false;
  let fetchOnly = false;
  let searchOnlyTurn = false;
  let allFailed = false;

  updateModeState(modeStatePath, (doc) => {
    const mode = effectiveMode(doc, sessionId);
    const sessionEntry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
    const turn = sessionEntry.turn || {
      turn: 1,
      required: mode === "required",
      disabled: mode === "off",
      exempted: false,
      externalWebCompleted: false,
      webSearchCompleted: false,
      webSearchSucceeded: false,
      webFetchCompleted: false,
      webFetchSucceeded: false,
      correctionCount: 0,
    };
    // The research requirement is FROZEN at turn start (newTurn / begin-turn).
    // A mid-turn mode change — including a model calling `web_mode set off` —
    // must not release the current turn's Stop gate; it takes effect next turn.
    // Only sessions without any hook-written turn state fall back to the live
    // mode, which is the degraded "hooks not loaded" case.
    const turnRequired = turn.required === true && !turn.exempted;
    if (!turnRequired) return;

    // requiredEvidence is frozen at turn start like `required`. The default
    // "search" demands a real search; reading a URL alone does not settle it.
    // Turns recorded before this field existed keep their original semantics.
    const searchOnly = turn.requiredEvidence === "search";
    searchOnlyTurn = searchOnly;
    const completed = searchOnly
      ? Boolean(turn.webSearchCompleted || turn.externalSearchCompleted)
      : Boolean(turn.webSearchCompleted || turn.webFetchCompleted || turn.externalWebCompleted);
    const succeeded = searchOnly
      ? Boolean(turn.webSearchSucceeded || (turn.externalSearchCompleted && turn.externalSearchSucceeded !== false))
      : Boolean(
        turn.webSearchSucceeded ||
        turn.webFetchSucceeded ||
        (turn.externalWebCompleted && turn.externalWebSucceeded !== false),
      );
    fetchOnly = searchOnly && !completed && Boolean(turn.webFetchCompleted || turn.externalWebCompleted);

    if (completed && succeeded) return;
    allFailed = completed;

    // One correction per turn, shared by "no research yet" and "every lookup
    // failed": the second Stop always lets the turn end.
    if ((turn.correctionCount ?? 0) === 0 && !repeatedStop) {
      turn.correctionCount = 1;
      Object.defineProperty(doc.sessions, sessionId, {
        value: {
          ...sessionEntry,
          turn,
          updatedAt: Date.now(),
        },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      shouldSteer = true;
      turnId = turn.turn;
    } else {
      failedResearch = true;
    }
  });

  if (shouldSteer) {
    // exitCode instead of process.exit lets queued stderr drain (Node docs:
    // process.exit may truncate pending writes on POSIX pipes).
    const fetchOnlyNote = fetchOnly ? ` ${FETCH_ONLY_NOTE}` : "";
    const text = allFailed ? failedResearchCorrectionText(searchOnlyTurn) : `${requiredSearchCorrectionText(searchOnlyTurn)}${fetchOnlyNote}`;
    process.stderr.write(`${text} (session_id="${sessionId}", turn_id=${turnId})`);
    process.exitCode = 2;
    return;
  }
  if (failedResearch) {
    process.stdout.write(`${FAILED_RESEARCH_REMINDER}\n`);
  }
}

main().catch(hookFailure);
