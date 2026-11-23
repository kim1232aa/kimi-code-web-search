---
description: Show the address of the configured Kimi Web Tools dashboard without starting a gateway
---

You are handling the `/web:dashboard` command.

## Instructions

1. Call the bundled `web_status` with `{}` if available. If it is unavailable or fails, report that and stop. Do not start a gateway to check its address.
2. Show the returned `Dashboard & Gateway URL`, not the server's `Gateway bind URL`. Do not assume a loopback address. Summarize what the user can configure in the dashboard:
   - Topbar `SearchModeButton` with all four modes: `auto` (智能联网), `smart` (`Jev 判定`), `required` (始终联网), and `off` (关闭联网), with Global/Session selector and Light/Dark theme toggle.
   - Smart/Jev classifier panel: TypeSafe System One, OpenRouter, or OpenAI-compatible backend, endpoint/model/credentials, timeout, and classifier test action. With transcript context enabled, every classified turn sends `last_assistant_reply` and `recent_tools` from Kimi `wire.jsonl`, and short follow-ups (at most 24 characters) additionally send `recent_user_context` (the previous user turn); this context is sent to the selected classifier. Classifier errors fail open.
   - No-route exemption (`exemptWhenNoProvider`, default `true`) and external web tool receipt recognition (`recognizeExternalWebTools`, default `true`), the "Require a search (URL reads do not count)" switch (`requiredEvidence`, default `search`), plus optional independent `fetchOrder`. An explicit fetch order is followed exactly; an empty one follows search order and ends with built-in HTTP. `enabled: false` also exempts enforcement. Receipt hooks are best-effort, and a no-route exemption or failed call is not verification: unchecked claims must be reported as `未验证`.
   - Provider API keys (multi-key pools, health status, quotas), without showing raw credentials.
   - Drag-and-drop search order and routing policy (`ordered`, `round-robin`, `random`). The optional `web_search.provider` override names a configured provider to try first for multi-source cross-verification (an unknown or disabled provider fails explicitly; a transient failure falls back through the remaining enabled chain); use `web_fetch` on primary-source URLs to verify important details.
   - Custom search sources (Tavily-compatible, SearXNG JSON, or Generic JSON APIs).
   - Xiaohongshu (小红书) and Twitter/X dedicated browser session login.
3. Mention `/web:mode smart` (`Jev 判定`) as a command alternative; aliases are `jev`, `自适应`, and `智能判定`.

User request: $ARGUMENTS
