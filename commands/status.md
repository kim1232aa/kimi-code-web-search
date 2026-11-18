---
description: Inspect Kimi Web Tools gateway health, active search mode, provider routing chain, and platform sessions
---

You are handling the `/web:status` command.

## Instructions

1. Call `web_status` with `{ "include_quotas": true }`.
2. Present a concise summary including:
   - Gateway URL and running PID.
   - Current Search Mode: `auto` (on-demand research), `smart` (`Jev 判定`, the Jev classifier decides per turn), `required` (research every turn), or `off` (this plugin's web tools disabled).
   - Smart/Jev classifier configuration/status when returned: TypeSafe System One, OpenRouter, or OpenAI-compatible backend; do not print credentials. Smart fails open on classifier failure; with transcript context enabled, every classified turn sends `last_assistant_reply` and `recent_tools` from Kimi `wire.jsonl`, and short follow-ups (at most 24 characters) additionally send `recent_user_context` (the previous user turn).
   - Global `enabled` flag, no-route exemption (`exemptWhenNoProvider`, default `true`), external-tool receipt (`recognizeExternalWebTools`, default `true`), and required evidence (`requiredEvidence`, default `search`; `search-or-fetch` also accepts a URL read) settings when returned; `enabled: false` also exempts enforcement. Completed recognized external calls can satisfy a turn, while failed calls remain unverified; receipt hooks are best-effort. Do not infer values missing from the response.
   - Active Search Routing Policy (`ordered`, `round-robin`, or `random`), search fallback chain, and independent fetch chain (`fetchOrder`, if configured).
   - Configured built-in and custom providers, key pool status, and quota snapshots, without exposing raw keys.
   - Social platform sessions (`xiaohongshu` and `x`) authentication and runtime status.
3. Explain that `web_search` accepts an optional `provider` naming a configured source to try first for cross-verification (an unknown or disabled provider fails explicitly; a transient failure falls back through the remaining enabled chain), and `web_fetch` verifies important details against primary sources. If research fails or no usable route exempts enforcement, report unchecked claims as `未验证` rather than verified.
4. If the user wants to change modes, use `/web:mode auto|smart|required|off`; `smart` (`Jev 判定`) also accepts `jev`, `自适应`, and `智能判定`.

User request: $ARGUMENTS
