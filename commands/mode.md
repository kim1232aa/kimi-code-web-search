---
description: View or switch the Kimi Web Tools search mode (auto / smart / required / off)
---

You are handling the `/web:mode` command.

## Instructions

1. Inspect `$ARGUMENTS`:
   - If `$ARGUMENTS` is `auto` (or `智能联网`), call `web_mode` with `{ "action": "set", "mode": "auto" }`.
   - If `$ARGUMENTS` is `smart` (UI label `Jev 判定`; also `jev`, `自适应`, `智能判定`), call `web_mode` with `{ "action": "set", "mode": "smart" }`.
   - If `$ARGUMENTS` is `required` (or `always`, `始终联网`), call `web_mode` with `{ "action": "set", "mode": "required" }`.
   - If `$ARGUMENTS` is `off` (or `disable`, `关闭联网`), call `web_mode` with `{ "action": "set", "mode": "off" }`.
   - If `$ARGUMENTS` is `toggle`, call `web_mode` with `{ "action": "toggle" }` (cycle: `auto → smart → required → off → auto`).
   - If `$ARGUMENTS` is empty, call `web_mode` with `{ "action": "get" }` and explain the four modes: `auto` researches on demand; `smart` (`Jev 判定`) uses the Jev Smart Classifier to decide per turn; `required` requires research each turn; `off` disables this plugin's web tools.
2. Report the active Search Mode concisely. For `smart`, explain that the classifier supports TypeSafe System One, OpenRouter, or an OpenAI-compatible backend, and fails open on classification errors unless `failOpen: false` is configured, which escalates the turn instead. When transcript context is enabled, every classified turn sends `last_assistant_reply` and `recent_tools` read from Kimi `wire.jsonl`, and short follow-ups (at most 24 characters) additionally send `recent_user_context` (the previous user turn); choose a backend appropriate for the conversation's privacy needs. The Web UI Smart/Jev panel configures and tests it.
3. On required or Smart-escalated turns, use the hook-supplied `session_id` and `turn_id` for web calls. Optional `web_search.provider` names a configured provider to try first for cross-verification (an unknown or disabled provider fails explicitly; a transient failure falls back through the remaining enabled chain); use `web_fetch` on primary sources for important details.
4. Explain no-route exemption and external-tool receipts as configured (both default to `true`): `enabled: false` in an existing configuration always exempts enforcement, and `exemptWhenNoProvider` also exempts it when an existing configuration has no usable `kimi-web-tools` route; `recognizeExternalWebTools` accepts recognized external web calls, while failures remain unverified; `requiredEvidence` (default `search`) decides whether only a search settles a required turn or a URL read also counts (`search-or-fetch`). Receipt hooks are best-effort and asynchronous. Kimi Code grants the Stop hook one continuation per turn to steer the model before the turn ends. Stop enforcement applies at the main agent's turn boundary: subagent turn-ends share the session id and carry no agent identity, so while any subagent is active the Stop hook stays silent (fail-open) and consumes no correction budget. System-trigger turns (background task notifications, goal continuations) are marked via `TurnStarted` and skip one Stop evaluation. Failed or exempt research must be reported honestly as `未验证`, never as verification. A mid-turn mode switch takes effect from the next user turn (the current turn's Stop decision is frozen at turn start), while `off` immediately blocks this plugin's web tools.

User request: $ARGUMENTS
