---
name: web-research
description: Use when web search, primary-source verification, full-page extraction, Xiaohongshu or X research, or Kimi Web Tools provider and Search Mode configuration is needed.
---

# Web Research Skill (`kimi-web-tools`)

Use `web_search` to discover sources and `web_fetch` to inspect evidence. A completed search satisfies a required turn; it does not by itself verify a claim.

## 1. Discovery, Cross-Verification, and Evidence

- Use `web_search` for relevant URLs, recent news, documentation, or social posts. Break complex questions into multi-angle sub-queries. Its optional `provider` parameter names a configured provider to try first for independent cross-checks. An unknown or disabled provider fails explicitly; on a transient failure or quota limit, do **not** retry that provider — switch immediately to another ready provider. Search for what the request actually depends on, not an arbitrary query to pass a check; when unsure of a URL, tool parameter, or command flag, search for it instead of guessing. When results are thin or conflict, rewrite the query and switch providers — never fill gaps from memory (`未搜到不等于不存在`). Cross-verify with 1–2 other providers when coverage has gaps or sources conflict, and stop once sufficient primary evidence is gathered.
- Use `web_fetch` for a supplied URL or a discovered primary source: official documentation, release notes, papers, source code, or original announcements, and cite key links. Even on local coding/config tasks in required or escalated turns, verify external library/API/CLI claims before writing them. Compare the underlying sources rather than counting duplicate snippets as independent confirmation.
- Never present search snippets as full-page verification or user comments. Describe comments/replies as verified only when `web_fetch` returns their contents.
- Absence of search hits is not proof of non-existence (`未搜到不等于不存在`). Calling `web_mode` or `web_status` does not satisfy a required turn. If a request fails, a classifier fails open, or no usable route exempts enforcement, identify unchecked claims as **未验证** and state why. Do not invent citations or treat an attempted request as successful verification.

Example cross-check: call `web_search({ query: "example project release notes", provider: "brave" })`, compare another configured provider's results, then `web_fetch({ url: "https://example.org/releases" })` for the primary-source details. On required or Smart-escalated turns, include the exact hook-supplied `session_id` and `turn_id` in web calls.

## 2. Social Platform Routing (`小红书:` and `X:`)

When platform sources are enabled, prefix the query with exactly one routing marker, such as `小红书: 机械键盘测评` or `X: project release notes`. The gateway removes the prefix before entering the platform search box; do not repeat the platform name in the topic keywords. Pass a returned post URL to `web_fetch({ url })` to read the full post and comments.

## 3. Four Search Modes

Call `web_mode({ action: "set", mode: "auto" | "smart" | "required" | "off" })`, or use `action: "toggle"` to cycle `auto → smart → required → off → auto`.

- **`auto` (智能联网)**: Research current, external, or verifiable facts as needed; otherwise answer from context.
- **`smart` (`Jev 判定`)**: The Jev Smart Classifier uses TypeSafe System One, OpenRouter, or an OpenAI-compatible backend to decide whether this turn requires research. Escalated turns follow `required`; non-escalated turns may finish without research. Errors, timeouts, and missing keys fail open by default (`failOpen: false` escalates the turn instead).
- **`required` (始终联网)**: Search before finalizing, using this turn's `session_id` and `turn_id`; never reuse another turn's binding. By default (`requiredEvidence: "search"`) only a search settles the turn and reading a URL alone does not; `search-or-fetch` also accepts a URL read. If every lookup failed, the Stop gate steers once to switch sources.
- **`off` (关闭联网)**: Do not use this plugin's web tools; this does not disable other plugins' tools.

`/web:mode smart` accepts aliases `jev`, `自适应`, and `智能判定`. The Smart hook accepts text or Kimi `ContentPart[]` prompts. When transcript context is enabled, it reads the tail of `$KIMI_CODE_HOME/sessions/<wd>/<session_id>/agents/main/wire.jsonl` and sends `last_assistant_reply` and `recent_tools` to the configured classifier on every classified turn; `recent_user_context` (the previous user turn) is additionally sent only for short follow-ups of at most 24 characters. Choose a backend appropriate for the conversation's privacy needs.

An existing configuration with `enabled: false` always exempts research enforcement. When `exemptWhenNoProvider` is enabled (default `true`), an existing configuration without a usable `kimi-web-tools` web route exempts enforcement too and emits a no-route notice. When `recognizeExternalWebTools` is enabled (default `true`), recognized external web calls are classified as a search or a page read (a `url`/`urls` argument always means a page read); a search satisfies the current turn, a page read only under `requiredEvidence: "search-or-fetch"`, and failed calls count as attempts but remain unverified. Discovery, status, and asynchronous job-start tools do not count, and receipt hooks are best-effort. None of these options weakens the evidence rules above. A Kimi subagent does not inherit or settle the parent turn: pass `session_id` and `turn_id` only to continue that exact turn, and use only tools actually available to the subagent. A call carrying the current session's binding counts toward that turn even when made by a subagent. Mode switches take effect from the next turn (the current turn's Stop decision is frozen at turn start), and `off` immediately blocks this plugin's web tools.

## 4. Status and Web UI

Call `web_status({ include_quotas: true })` for mode, routing policy (`ordered`, `round-robin`, `random`), key health, quotas, and platform login state. The dashboard at `http://127.0.0.1:18492` offers the four-mode `SearchModeButton` (`smart` is labelled `Jev 判定`) with Global/Session scope and a Smart/Jev classifier panel for backend, endpoint/model, credentials, timeout, test action, no-route exemption, and external receipts. Reload plugin/session hooks after installation or updates. Keep keys, private endpoints, and transcript data out of public examples and reports.
