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

## Choose how to connect

- **I already have a gateway and only need search and page reads:** use [direct HTTP MCP](#direct-http-mcp-no-local-gateway). No plugin install, Node.js, or local gateway is needed on the Kimi client.
- **I want the full plugin and a gateway on this machine:** [build and install the plugin](#build-and-install-the-plugin), then follow [local gateway first run](#local-gateway-first-run).
- **I want to keep the bundled MCP tools but send their requests elsewhere:** [build and install the plugin](#build-and-install-the-plugin), then [point the stdio bridge at a remote gateway](#stdio-bridge-to-a-remote-gateway). Read the [remote policy limitations](#remote-policy-limitations) before relying on Jev or required mode.

## Installation

### Install a built ZIP

Use the built `kimi-code-web-search-<version>.zip`, not GitHub's automatic **Source code** archive. The ZIP includes the gateway, dashboard, and npm runtime dependencies; no npm install or build is needed on the target. Node.js is still needed to run a local gateway.

For a local ZIP, extract it and install the absolute path to the directory containing `kimi.plugin.json` using the TUI commands below. For a hosted ZIP, pass its direct download URL to `/plugins install`. To produce the ZIP yourself, run `npm ci --include=dev` and `npm run package:plugin` in the checkout with `python3` on `PATH`. The ZIP is written to `dist/release/`.

### Build and install the plugin

Use these steps when you don't have a built ZIP. Installing the raw GitHub repository URL copies source, not the built gateway or its dependencies.

On the machine that runs Kimi Code, use a recent Kimi Code CLI with plugin support, Git, and Node.js 22 LTS (22.6+). These are the plugin/gateway requirements, not requirements for a client that only connects over HTTP.

```bash
git clone https://github.com/kim1232aa/kimi-code-web-search.git
cd kimi-code-web-search
node --version
npm ci --include=dev
npm run build
```

In the **Kimi Code TUI** (not your shell), replace `<absolute-path-to-clone>` with the directory containing `kimi.plugin.json`, then run:

```text
/plugins install <absolute-path-to-clone>
/reload
```

Open a new session and check `/plugins info web` and `/mcp`. The plugin ID is `web`; the bundled stdio server is `s` (prefix `mcp__plugin-web_s__` in tool names). Desktop installation settings are under **Settings → Plugins**; for the local build, use the TUI install commands with the same Kimi data directory as Desktop, then open a new Desktop session. See [Kimi plugin installation](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html) and [Desktop settings](https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html).

Kimi copies the prepared folder to `$KIMI_CODE_HOME/plugins/managed/web/`. After changes, rebuild and reinstall from the clone; `/reload` alone does not copy new files.

### Local gateway first run

1. From the built checkout or unpacked plugin, run `node ./bin/gateway-daemon.mjs ensure`, then open `http://127.0.0.1:18492`. With no remote URL configured, `web_search` and `web_fetch` can start the local gateway on demand. `web_status`, `web_mode`, and `/web:dashboard` do not start it.
2. Configure a usable search source on that gateway: add a provider key (e.g. `WEB_TOOLS_EXA`) or configure a supported keyless source. For Xiaohongshu / X native browsing, configure a supported browser on the gateway host.
3. Run `/web:status` in the new Kimi session, then try one real search. A healthy process or connected MCP server does not prove that a search provider works.

Provider keys configured in the dashboard are stored on the gateway host in `$KIMI_CODE_HOME/web-tools/credentials.json`, not in `mcp.json`.

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
| `mcp__plugin-web_s__web_status` | Search engines that can actually run a query |

### Slash commands

- `/web:mode [auto|smart|required|off|toggle]` — view or switch the mode (`smart` also accepts `jev`, `自适应`, `智能判定`).
- `/web:status` — engines that can actually search.
- `/web:dashboard` — point at the gateway-host dashboard; does not start a gateway.

When plugin and gateway share the same data directory, a mid-turn mode switch takes effect from the next user turn; `off` immediately blocks the bundled retrieval tools. The [remote policy limitations](#remote-policy-limitations) apply when they do not share state.

### Skill

Use `/skill:web:web-research` for deeper research (query design, cross-checks and primary sources). The Skill is optional; ordinary searches can call any available search tool directly, and if a skill name is not found after a reinstall, run `/reload` rather than retrying the name. It is not provided by HTTP MCP alone.

## Configuration

Gateway settings and credentials live under `$KIMI_CODE_HOME/web-tools/` on the gateway host. Configure the client connection separately as described in [Connect to a remote gateway](#connect-to-a-remote-gateway).

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

## Connect to a remote gateway

The Kimi plugin runs hooks and loads skills on the **client**. The **gateway** runs search and page reads and holds the provider credentials. Configure search providers on the gateway host. For remote access, use a trusted HTTPS endpoint, keep the gateway bound to loopback behind a reverse proxy, and forward the original client address (`X-Forwarded-For`) so proxied requests are not treated as direct loopback calls. Set the gateway password on the server (`KIMI_WEB_TOOLS_PASSWORD` or the `web-tools/public-password` file). The client's `KIMI_WEB_TOOLS_GATEWAY_TOKEN` holds that password, not a search-provider key. It grants dashboard access too; only give it to trusted clients. Never put the value in the plugin manifest, a shared `mcp.json`, or a chat transcript.

### Direct HTTP MCP (no local gateway)

1. If plugin `web` is installed on the client, use `/plugins mcp disable web s` and `/reload` in the TUI to disable **only** its bundled stdio server. If the plugin is not installed, skip this step. Adding an HTTP server does not replace the bundled server automatically.
2. Merge the example below into the client’s `mcp.json`; keep existing servers. The user-level file is `~/.kimi-code/mcp.json` (Windows: `%USERPROFILE%\.kimi-code\mcp.json`; with a custom data root: `$KIMI_CODE_HOME/mcp.json`). A project-only entry goes in `.kimi-code/mcp.json`; Kimi may require workspace trust. Replace `https://search.example.com` with the reachable gateway origin and **keep `/mcp`**. The same file format applies to [Desktop](https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html#mcp) and [CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html).
3. Set `KIMI_WEB_TOOLS_GATEWAY_TOKEN` in the environment of the process running Kimi. `bearerTokenEnvVar` names the variable; it does not contain the password. If Kimi was running when the variable changed, fully quit and relaunch it from an environment that has the variable; reloading a conversation does not update the app's inherited environment. In PowerShell use `$env:NAME` for a shell-launched CLI; for Desktop launched separately, use a Windows user-level environment variable or launch it from an environment that already has it. Set it on the host running Kimi, not an unrelated terminal or the gateway host only.

```json
{
  "mcpServers": {
    "web-remote": {
      "url": "https://search.example.com/mcp",
      "bearerTokenEnvVar": "KIMI_WEB_TOOLS_GATEWAY_TOKEN",
      "enabledTools": ["web_search", "web_fetch"]
    }
  }
}
```

Open a **new** session. In the TUI, check `/mcp`: `web-remote` should be connected, and `plugin-web_s` should not be active. Test a search and a page read with that server. The gateway advertises `web_search`, `web_fetch`, `web_status`, and `web_mode`; the allowlist exposes only the retrieval tools. `web_status` lists usable engines and does not expose bind addresses. `web_mode` changes **gateway-side** Search Mode and is not needed for an MCP-only client.

### Stdio bridge to a remote gateway

Keep plugin `web` and its server `s` enabled; do not add a second copy of the search tools to `mcp.json`. Set `KIMI_WEB_TOOLS_GATEWAY_URL` to the **gateway origin, without `/mcp`**, and `KIMI_WEB_TOOLS_GATEWAY_TOKEN` in the Kimi process environment. Then relaunch Kimi and open a new session. In the following examples, supply the token separately as described above; the URL alone does not authenticate requests.

```bash
export KIMI_WEB_TOOLS_GATEWAY_URL="https://search.example.com"
kimi
```

```powershell
$env:KIMI_WEB_TOOLS_GATEWAY_URL = 'https://search.example.com'
kimi
```

`/mcp` should show the bundled server (`plugin-web_s`). Test a search. The bridge calls `/web-tools/mcp/*`, not the public `/mcp` endpoint; the reverse proxy must expose those routes for this option. A configured remote request that fails does **not** fall back to local startup. If the URL is missing from the stdio process, it assumes a local gateway: retrieval can start it, but mode and status queries only check for an existing gateway. Launching Desktop independently of the shell does not give it that shell's variables.

### Remote policy limitations

- **Direct HTTP is a tools connection, not a plugin install.** It does not install the Skill, slash commands, or hooks. If you keep the plugin enabled for its hooks, `web-remote` can count as an external search when `recognizeExternalWebTools` is enabled and the receipt is recorded. The bundled `off` hook does not block this separate MCP entry.
- **Neither connection shares the client's turn state with the gateway.** In both remote paths, a request carrying a client-only `turn_id` can fail with `Stale or unknown turn`; an unbound request can also be rejected if the gateway itself is in `required` mode. Status and mode queries describe the gateway, not the client's policy. Do not assume cross-host Jev, `required`, or `off` is equivalent to running both parts on one host. Leave the search-provider keys on the gateway.

### MCP troubleshooting

- **`Gateway exited before becoming healthy` / `Cannot find package 'linkedom'`:** the bundled stdio tool tried local startup. For HTTP-only use, check that `s` is disabled and retest in a new session. For intended local use, rebuild and reinstall from a prepared directory; inspect `$KIMI_CODE_HOME/web-tools/gateway.log` (default `~/.kimi-code/web-tools/gateway.log`). A missing runtime package is not fixed by installing a newer Node alone.
- **HTTP `401` / `auth-not-configured`:** for `401`, check that the actual Kimi process has the gateway token without printing it; for `auth-not-configured`, set a password on the gateway. Check `GET /health` on the gateway origin to distinguish network reachability from authentication: a healthy response does not test the token, MCP initialization, or any search provider.
- **Two sets of tools or `outside the tool choice`:** check `/mcp`, keep only your chosen connection, then start a new session and use the tool names it declares. If a remote status or dashboard reply shows `127.0.0.1:18492`, that is a listen address, not the URL to open on your client. Use the configured HTTPS origin for the remote dashboard.

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