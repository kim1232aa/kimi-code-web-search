# Kimi Web Tools

**English** | [中文](README.zh-CN.md)

Multi-provider web search & fetch plugin for [Kimi Code CLI](https://www.kimi.com/code), with a per-session **Search Mode** policy, a **Jev smart classifier**, Xiaohongshu / X research, and a local **Web UI dashboard**.


> The repository was renamed from `kimi-web-tools` to `kimi-code-web-search` on 2026-11-22. GitHub redirects the old URL, so existing clones keep working.

The plugin itself is free and open source (MIT). You bring your own search-provider API keys; most providers offer a free tier that covers personal use. See [Pricing](#pricing).

![Search mode menu](assets/search-mode-menu.png)

## Features

- **`web_search`** — one tool across a configurable provider pool: Exa, Tavily, Brave, You.com, Firecrawl, Parallel, Jina, Keenable, self-hosted SearXNG, plus custom sources (Tavily-compatible, SearXNG JSON, or generic JSON APIs). Multi-key pools with health-aware rotation, quota tracking, and automatic fallback. Routing policies: `ordered`, `round-robin`, `random`. An optional `provider` argument picks a source to try first for cross-verification.
- **`web_fetch`** — clean readable Markdown/text extraction from any public URL, with an independent fetch chain (`fetchOrder`) ending in built-in HTTP. For Xiaohongshu and X post URLs it returns the full post body and top comments.
- **Social platform research** — prefix a query with `小红书:` or `X:` to search inside the platform (requires a logged-in browser session, configured in the dashboard). The gateway strips the prefix before typing into the platform search box.
- **Four Search Modes**, enforced through Kimi Code lifecycle hooks:
  - `auto` (智能联网) — research on demand, answer from context otherwise.
  - `smart` (Jev 判定) — a small classifier decides per turn whether web research is required. Backends: TypeSafe System One (`jev-latest` by default), OpenRouter, or any OpenAI-compatible endpoint. Fails open on errors/timeouts unless you set `failOpen: false`.
  - `required` (始终联网) — every user turn must complete a real search before the reply ends. By default only a search counts (`requiredEvidence: "search"`); switch to `"search-or-fetch"` to also accept a URL read. Recognized external web tools (e.g. other MCP search servers) count too. A Stop-hook gate steers once when nothing was searched or every lookup failed, then lets the turn end with failures reported as unverified — no infinite loops.
  - `off` (关闭联网) — this plugin's web tools are blocked; other plugins are unaffected.
- **Anti-hallucination prompt discipline** — search what the request actually depends on, verify against primary sources, never retry a failing provider, never fill gaps from memory ("未搜到不等于不存在" / absence of hits ≠ non-existence).
- **Web UI dashboard** at `http://127.0.0.1:18492` — provider keys & quotas, drag-and-drop routing order, Smart/Jev panel with a classifier test action, mode switches (global or per-session), platform login, light/dark theme, English/中文 UI.
- **Pi import** — one command migrates API keys, endpoints, routing, and search mode from a local Pi agent setup (`always-search.ts` + `pi-web-access`).
- **Subagent-aware enforcement** — subagent activity, system-trigger turns, and session cleanup are handled so the required-mode gate never misfires on background turns.

## Requirements

- Kimi Code CLI (recent version with plugin support).
- Node.js ≥ 22.6 (LTS 22+ recommended; the dev/test scripts use `--experimental-strip-types`).
- At least one search provider API key — or a self-hosted SearXNG instance. Keenable also works without a key (rate-limited).
- Optional: a local Chrome/Chromium/Edge install for Xiaohongshu / X browser sessions.

## Installation

### Option A — install from GitHub (recommended)

In the Kimi Code TUI:

```
/plugins install https://github.com/kim1232aa/kimi-code-web-search
/reload
```

Then start a **new session** (`/new`). Plugin changes only apply after `/reload` or in new sessions.

> Note: compiled output (`lib/`, `dist/`) is not committed. If the installed copy lacks `lib/`, the entry scripts fall back to running the TypeScript sources directly, which requires Node ≥ 22.6 with type stripping. If anything fails to start, use Option B.

### Option B — build locally, then install from the local path

```bash
git clone https://github.com/kim1232aa/kimi-code-web-search.git
cd kimi-code-web-search
npm install
npm run build
```

Then in the Kimi Code TUI:

```
/plugins install /absolute/path/to/kimi-code-web-search
/reload
```

Local installs are copied to `$KIMI_CODE_HOME/plugins/managed/<id>/`; the CLI always runs from that managed copy. After editing the source you must rebuild and reinstall.

### First run

1. Run `/web:dashboard` (or open `http://127.0.0.1:18492`). The gateway daemon starts automatically on first use.
2. Add at least one provider API key in the dashboard, or export environment variables before starting Kimi Code:

   ```bash
   export WEB_TOOLS_EXA="..."        # also: WEB_TOOLS_TAVILY, WEB_TOOLS_BRAVE,
   export WEB_TOOLS_KEENABLE="..."   # WEB_TOOLS_YOU, WEB_TOOLS_FIRECRAWL,
                                     # WEB_TOOLS_PARALLEL, WEB_TOOLS_JINA, WEB_TOOLS_SEARXNG
   ```

3. Check everything with `/web:status`.

Keys are stored in `$KIMI_CODE_HOME/web-tools/credentials.json` (mode `0600`) and are never printed in logs, status output, or import summaries.

### Import from Pi (optional)

If you already use Pi's `always-search.ts` / `pi-web-access`:

```bash
node ./bin/import-pi.mjs            # reads ~/.pi/agent (or $PI_CODING_AGENT_DIR)
node ./bin/import-pi.mjs --pi-dir /path/to/pi/agent
```

Imports provider keys, base URLs, routing, classifier credentials (`auth.json`), and the search mode. Only a sanitized summary is printed.

## Usage

### Tools (MCP server `s`, plugin id `web`)

| Tool | Purpose |
| --- | --- |
| `mcp__plugin-web_s__web_search` | Web / platform search across the provider pool; optional `provider` override |
| `mcp__plugin-web_s__web_fetch` | URL → clean Markdown; full post + comments for 小红书 / X URLs |
| `mcp__plugin-web_s__web_mode` | Get / set / toggle the Search Mode |
| `mcp__plugin-web_s__web_status` | Gateway health, routing chain, key pools, quotas, platform sessions |

### Slash commands

- `/web:mode [auto|smart|required|off|toggle]` — view or switch the mode (`smart` also accepts `jev`, `自适应`, `智能判定`).
- `/web:status` — gateway, mode, routing, quotas, platform login summary.
- `/web:dashboard` — ensure the gateway is running and show the dashboard URL.

A mid-turn mode switch takes effect from the next user turn; `off` blocks this plugin's web tools immediately.

### Skill

The bundled `web-research` skill teaches the agent the research workflow: claim-focused queries, multi-angle sub-queries, provider switching instead of retrying, primary-source verification via `web_fetch`, and honest `未验证` reporting.

## Configuration

Everything is configurable in the dashboard; files live under `$KIMI_CODE_HOME/web-tools/` (`config.json`, `credentials.json`, `mode-state.json`, `gateway.json`).

| Setting | Default | Meaning |
| --- | --- | --- |
| Search mode | `auto` | Global default; per-session overrides supported |
| `requiredEvidence` | `"search"` | In required mode, only a search settles the turn; `"search-or-fetch"` also accepts a URL read |
| `recognizeExternalWebTools` | `true` | Count recognized external web/MCP search & fetch calls toward the turn |
| `exemptWhenNoProvider` | `true` | Skip enforcement when no usable route is configured (still report unchecked facts as unverified) |
| Smart classifier | TypeSafe `jev-latest` | Backend, model, endpoint, timeout, `failOpen` (`true`), transcript context toggle |
| `fetchOrder` | `[]` | Empty = follow search order + built-in HTTP last; explicit list is followed exactly |
| Routing policy | `ordered` | `ordered` / `round-robin` / `random` |

Environment variables:

| Variable | Purpose |
| --- | --- |
| `WEB_TOOLS_<PROVIDER>` | Provider API key (see list above) |
| `KIMI_WEB_TOOLS_HOST` / `KIMI_WEB_TOOLS_PORT` | Gateway bind address (default `127.0.0.1:18492`) |
| `KIMI_WEB_TOOLS_PASSWORD` | Dashboard password for non-loopback access (or a `public-password` file in the data dir) |
| `KIMI_WEB_TOOLS_REQUIRE_AUTH=1` | Require the password even for loopback requests |
| `KIMI_CODE_HOME` | Kimi Code data root (default `~/.kimi-code`) |

**Privacy note (Smart/Jev):** with transcript context enabled, every classified turn sends the last assistant reply and recent tool names (read from the session's `wire.jsonl`) to the classifier endpoint; short follow-ups (≤ 24 chars) additionally include the previous user turn. Choose a backend appropriate for your conversation's privacy needs, or disable transcript context in the Smart/Jev panel.

## Pricing

The plugin is **free (MIT)**. Costs come only from the providers you enable. Published prices below were checked on **2026-11-22** against vendor pricing pages (links in the table); they change often — treat them as a snapshot, not a quote.

| Provider | Free tier | Paid price (entry) | Source |
| --- | --- | --- | --- |
| **Exa** | $10 credits/month + $10 one-time bonus, no card | Search from $4/1k (Lite), $7/1k (Auto), $12/1k (Deep); contents $1/1k pages | [exa.ai/pricing](https://exa.ai/pricing) |
| **Tavily** | 1,000 credits/month, no card (basic search = 1 credit) | Pay-as-you-go $0.008/credit (≈ $8/1k basic searches); plans from $30/mo | [tavily.com/pricing](https://www.tavily.com/pricing) |
| **Brave** | Monthly free credits (≈ $5/mo for Search; card required) | Search $5/1k requests | [brave.com/search/api](https://brave.com/search/api/) ¹ |
| **You.com** | 100 Web Search queries/day via keyless MCP | Web Search $5/1k calls; Extract Lite $0.90/1k URLs | [you.com/pricing](https://you.com/pricing) |
| **Firecrawl** | 1,000 credits/month, no card (search = 2 credits/10 results ≈ 500 searches) | Hobby $19/mo for 5,000 credits; Standard $99/mo for 100,000 | [firecrawl.dev/pricing](https://www.firecrawl.dev/pricing) |
| **Parallel** | $5 credits/month (card on file) + up to $80 signup credit | Search from $1/1k (Turbo/Fast), $5/1k (Basic/Advanced); Extract $1/1k URLs | [parallel.ai/pricing](https://parallel.ai/pricing) |
| **Jina** | 10M tokens per new API key; Reader works keyless at 20 RPM | Token-based; each `s.jina.ai` search costs ≥ 10,000 tokens (≈ $0.50/1k searches at published token rates ²) | [jina.ai/reader](https://jina.ai/reader/) |
| **Keenable** | Keyless: free, 1,000 req/hour per IP. With key: 100,000 req/month free | $4/1k requests after the free allowance | [docs.keenable.ai/pricing](https://docs.keenable.ai/pricing) |
| **SearXNG** | Self-hosted, free (your server costs) | — | [searxng.org](https://searxng.org) |

¹ Brave's marketing page describes prepaid credits; the $5/1k rate and monthly credit amount are corroborated by an independent pricing survey ([crawlfolio, verified 2026-11-12](https://crawlfolio.com/web-search-api-pricing/)) rather than a machine-readable official table.
² Jina bills by tokens, not requests; the per-1k figure assumes ~$0.05/M paid tokens as reported by third-party trackers — check your key's current token pack price.

The **Jev smart classifier** adds one small LLM call per classified turn, billed by whichever backend you configure (TypeSafe System One, OpenRouter, or your own endpoint).

A typical personal setup can run entirely on free tiers: e.g. Keenable keyless + Tavily's 1,000 monthly credits + Exa's $10 monthly credits.

## Standalone gateway

The gateway also runs outside Kimi Code:

```bash
node ./bin/gateway-daemon.mjs            # foreground
node ./bin/gateway-daemon.mjs --daemon   # detached background daemon
node ./bin/gateway-daemon.mjs ensure     # start if not running
node ./bin/gateway-daemon.mjs status     # status JSON
node ./bin/gateway-daemon.mjs stop
curl http://127.0.0.1:18492/health
```

Package exports: `kimi-code-web-search` (host API), `kimi-code-web-search/gateway`, `kimi-code-web-search/storage`. Binaries: `kimi-code-web-search-gateway`, `kimi-code-web-search-mcp`, `kimi-code-web-search-import-pi`.

## Known limitations

- **Tool renames vs. old sessions.** Kimi Code freezes a session's declared tool list at session start. If the plugin's tool names change (as they did in v0.4.0, `kimi-web-tools` → `web` (the repo is now `kimi-code-web-search`)), sessions opened *before* the change keep declaring the old names; models that call the new names can be rejected by strict upstream gateways that validate function names against the request's tool declarations. Start a new session after updating the plugin.
- **Required mode needs the hooks loaded.** After installing/updating, run `/reload` or start a new session before relying on enforcement. Hooks fail open on execution errors.
- **Stop-hook budget.** Kimi Code grants one continuation per turn; a second Stop always ends the turn. Failed research is reported as unverified, never silently retried forever.
- **Platform sessions** (小红书 / X) depend on a local browser and can expire; log in again from the dashboard when needed.
- **Receipt hooks are best-effort.** `PostToolUse` / `PostToolUseFailure` are observation-only in Kimi Code; external-tool recognition may occasionally miss a call.

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test (Node >= 22.6)
npm run build        # host (tsc) + client (esbuild)
```

Browser-dependent tests (`browser-lifecycle`, `browser-session`) need a local Chrome/Chromium and are skipped in headless CI-style runs.

## License

[MIT](LICENSE)