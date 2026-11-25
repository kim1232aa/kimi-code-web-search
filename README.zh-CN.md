# Kimi Web Tools

[English](README.md) | **中文**

面向 [Kimi Code CLI](https://www.kimi.com/code) 的多源联网搜索/网页读取插件：按会话生效的**搜索模式**策略、**Jev 智能判定**，以及本地 **Web UI 仪表盘**。


> 仓库于 2026-11-22 从 `kimi-web-tools` 改名为 `kimi-code-web-search`。GitHub 会重定向旧地址，已有克隆不受影响。

插件本身免费开源（MIT）。搜索 API key 由你自备；多数厂商的免费额度足够个人使用，详见[价格](#价格)。

![搜索模式菜单](assets/search-mode-menu.png)

## 功能

- **`web_search`** —— 一个工具打通可配置的搜索源池：Exa、Tavily、Brave、You.com、Firecrawl、Parallel、Jina、Keenable、自建 SearXNG，以及自定义源（Tavily 兼容、SearXNG JSON、通用 JSON API）。多 key 池、健康感知轮换、额度跟踪、自动降级。路由策略：`ordered`（顺序）、`round-robin`（轮询）、`random`（随机）。可选 `provider` 参数指定优先尝试的源，用于多源交叉验证。
- **`web_fetch`** —— 任意公开 URL → 干净可读的 Markdown/正文，独立的读取链（`fetchOrder`），兜底为内置 HTTP。
- **四种搜索模式**，通过 Kimi Code 生命周期钩子强制执行：
  - `auto`（智能联网）—— 按需联网，其余情况直接依据上下文回答。
  - `smart`（Jev 判定）—— 由小型分类器逐轮判定是否需要联网。后端支持 TypeSafe System One（默认模型 `jev-latest`）、OpenRouter、任意 OpenAI 兼容端点。出错/超时默认放行（fail open），配置 `failOpen: false` 则改为升级成必搜。
  - `required`（始终联网）—— 每个用户轮必须先完成一次真实搜索才能结束回答。默认只有搜索算数（`requiredEvidence: "search"`），切到 `"search-or-fetch"` 后读取 URL 也算。识别到的外部 web/MCP 搜索工具同样计入。没搜或全部失败时，Stop 门只纠偏一次，随后放行并要求把失败如实报告为未验证——不会死循环。
  - `off`（关闭联网）—— 屏蔽本插件的联网工具；不影响其他插件。
- **防幻觉提示词纪律** —— 围绕请求真正依赖的事实去搜、用一手来源核验、失败的源不重试而是换源、绝不凭记忆补全（"未搜到不等于不存在"）。
- **Web UI 仪表盘**（`http://127.0.0.1:18492`）——  provider key 与额度、拖拽排序路由、Smart/Jev 面板（含分类器测试）、全局/会话级模式切换、明暗主题、中英文界面。
- **Pi 导入** —— 一条命令从本地 Pi agent 配置（`always-search.ts` + `pi-web-access`）迁移 API key、端点、路由和搜索模式。
- **子代理感知** —— 正确处理子代理活动、系统触发轮和会话清理，必搜门不会在后台轮上误伤。

## 选择接入方式

- **已有网关，只需要搜索和读网页**：用 [HTTP MCP 直连](#http-mcp-直连)。Kimi 客户端无需安装本插件、Node.js 或本地网关。
- **要完整插件，网关也跑在这台机器**：[构建并安装插件](#构建并安装插件)，再按[本地网关首次使用](#本地网关首次使用)配置。
- **要保留插件自带工具，但请求发往别处**：[构建并安装插件](#构建并安装插件)，再配置 [stdio 桥接远程网关](#stdio-桥接远程网关)。使用 Jev 或必搜前，请先看[远程模式的限制](#远程模式的限制)。

## 安装

### 安装预构建 ZIP

使用构建好的 `kimi-code-web-search-<版本>.zip`，不要选 GitHub 自动生成的 **Source code** 压缩包。插件 ZIP 自带网关、仪表盘和 npm 运行依赖，目标机器不用再装依赖或构建。运行本地网关仍需要 Node.js。

如果 ZIP 在本地，先解压，再用下方的 TUI 命令安装 `kimi.plugin.json` 所在目录的绝对路径。如果 ZIP 已托管，可以把直链交给 `/plugins install`。要自行打包，在源码目录执行 `npm ci --include=dev` 和 `npm run package:plugin`，确保 `python3` 在 `PATH` 上；ZIP 生成在 `dist/release/`。

### 构建并安装插件

没有预构建 ZIP 时用这套步骤。直接安装 GitHub 仓库地址只会复制源码，不包含构建好的网关或它的运行依赖。

在运行 Kimi Code 的机器上准备支持插件的近期 Kimi Code CLI、Git 和 Node.js 22 LTS（22.6 或更高）。这是插件／网关侧的要求，不是纯 HTTP 客户端的要求。

```bash
git clone https://github.com/kim1232aa/kimi-code-web-search.git
cd kimi-code-web-search
node --version
npm ci --include=dev
npm run build
```

在 **Kimi Code TUI**（不是 PowerShell 或 Bash）里，把 `<克隆目录的绝对路径>` 换成包含 `kimi.plugin.json` 的目录，再运行：

```text
/plugins install <克隆目录的绝对路径>
/reload
```

新开会话，用 `/plugins info web` 和 `/mcp` 检查。插件 ID 是 `web`；自带的 stdio 服务叫 `s`（工具名前缀为 `mcp__plugin-web_s__`）。桌面版插件入口在**设置 → 插件**；从本地构建安装时，可用共用同一 Kimi 数据目录的 TUI 执行上述安装命令，再新开桌面会话。参见 [Kimi 插件安装文档](https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html)和[桌面版设置文档](https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html)。

Kimi 会把准备好的目录复制到 `$KIMI_CODE_HOME/plugins/managed/web/`。更新时先重新构建再安装；只 `/reload` 不会把新文件复制过去。

### 本地网关首次使用

1. 在构建好的仓库或解压后的插件目录执行 `node ./bin/gateway-daemon.mjs ensure`，再打开 `http://127.0.0.1:18492`。没配置远程地址时，只有 `web_search` 和 `web_fetch` 可按需启动本机网关；`web_status`、`web_mode` 和 `/web:dashboard` 都不启动它。
2. 在网关上配置可用的搜索源：添加搜索 API key（如 `WEB_TOOLS_EXA`），或配置受支持的免 key 搜索源（如 SearXNG）。
3. 在 Kimi 新会话运行 `/web:status`，再实际搜一次。进程健康或 MCP 已连接，不代表搜索源能用。

仪表盘配置的搜索源 key 保存在网关主机的 `$KIMI_CODE_HOME/web-tools/credentials.json`，不放在 `mcp.json`。

### 从 Pi 导入（可选）

如果你已在用 Pi 的 `always-search.ts` / `pi-web-access`：

```bash
node ./bin/import-pi.mjs            # 读取 ~/.pi/agent（或 $PI_CODING_AGENT_DIR）
node ./bin/import-pi.mjs --pi-dir /path/to/pi/agent
```

导入搜索 key、base URL、路由、分类器凭据（`auth.json`）和搜索模式，只打印脱敏摘要。

## 使用

### 工具（MCP 服务 `s`，插件 id `web`）

| 工具 | 用途 |
| --- | --- |
| `mcp__plugin-web_s__web_search` | 跨搜索源池的网页搜索；可选 `provider` 指定优先源 |
| `mcp__plugin-web_s__web_fetch` | URL → 干净可读的 Markdown/正文 |
| `mcp__plugin-web_s__web_mode` | 查看 / 设置 / 循环切换搜索模式 |
| `mcp__plugin-web_s__web_status` | 真正能发搜索的引擎列表 |

### 斜杠命令

- `/web:mode [auto|smart|required|off|toggle]` —— 查看或切换模式（`smart` 也接受 `jev`、`自适应`、`智能判定`）。
- `/web:status` —— 真正能搜的引擎。
- `/web:dashboard` —— 指向网关主机上的仪表盘，不启动网关。

插件与网关共用同一数据目录时，轮中切换模式从下一个用户轮生效；`off` 立即屏蔽自带的联网工具。不共享状态时，参见[远程模式的限制](#远程模式的限制)。

### Skill

深度研究可通过 `/skill:web:web-research` 加载查询设计、交叉验证和核查一手来源的流程。普通搜索直接用任意可用的搜索工具，不需要先加载 Skill；重装后 skill 名仍找不到时执行 `/reload`，不要反复重试名字。只接 HTTP MCP 不提供这个 Skill。

## 配置

网关设置和凭据位于网关主机的 `$KIMI_CODE_HOME/web-tools/`。客户端的连接方式单独配置，见[接入远程网关](#接入远程网关)。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| 搜索模式 | `auto` | 全局默认；支持按会话覆盖 |
| `requiredEvidence` | `"search"` | 必搜模式下只有搜索算数；`"search-or-fetch"` 则读取 URL 也算 |
| `recognizeExternalWebTools` | `true` | 识别到的外部 web/MCP 搜索与读取调用计入本轮 |
| `exemptWhenNoProvider` | `true` | 没有可用搜索路线时豁免强制（未核实的事实仍须标注未验证） |
| Smart 分类器 | TypeSafe `jev-latest` | 后端、模型、端点、超时、`failOpen`（`true`）、转录上下文开关 |
| `fetchOrder` | `[]` | 空 = 跟随搜索顺序 + 内置 HTTP 兜底；显式列表严格按序执行 |
| 路由策略 | `ordered` | `ordered` / `round-robin` / `random` |

环境变量：

| 变量 | 用途 |
| --- | --- |
| `WEB_TOOLS_<PROVIDER>` | 搜索源 API key（见上文列表） |
| `KIMI_WEB_TOOLS_HOST` / `KIMI_WEB_TOOLS_PORT` | 网关监听地址（默认 `127.0.0.1:18492`） |
| `KIMI_WEB_TOOLS_PASSWORD` | 非回环访问的仪表盘密码（也可用数据目录下的 `public-password` 文件） |
| `KIMI_WEB_TOOLS_REQUIRE_AUTH=1` | 回环请求也要求密码 |
| `KIMI_CODE_HOME` | Kimi Code 数据根目录（默认 `~/.kimi-code`） |

**隐私提示（Smart/Jev）**：开启转录上下文后，每个被分类的轮次会把上一条助手回复和最近工具名（读自会话 `wire.jsonl`）发送给分类器端点；短追问（≤ 24 字符）还会附带上一轮用户输入。请按对话的隐私需求选择后端，或在 Smart/Jev 面板关闭转录上下文。

## 价格

插件本身**免费（MIT）**。费用只来自你启用的搜索源。下表价格于 **2026-11-22** 对照厂商定价页核对（表中附链接）；价格经常变动，请以官方页面为准。

| 搜索源 | 免费额度 | 付费价格（入门档） | 来源 |
| --- | --- | --- | --- |
| **Exa** | 每月 $10 额度 + 一次性 $10 奖励，无需绑卡 | 搜索 $4/千次起（Lite）、$7/千次（Auto）、$12/千次（Deep）；内容读取 $1/千页 | [exa.ai/pricing](https://exa.ai/pricing) |
| **Tavily** | 每月 1,000 credits，无需绑卡（基础搜索 = 1 credit） | 按量 $0.008/credit（约 $8/千次基础搜索）；套餐 $30/月起 | [tavily.com/pricing](https://www.tavily.com/pricing) |
| **Brave** | 每月免费额度（Search 约 $5/月；需绑卡） | 搜索 $5/千次 | [brave.com/search/api](https://brave.com/search/api/) ¹ |
| **You.com** | 免 key MCP 每天 100 次 Web Search | Web Search $5/千次；Extract Lite $0.90/千 URL | [you.com/pricing](https://you.com/pricing) |
| **Firecrawl** | 每月 1,000 credits，无需绑卡（搜索 = 2 credits/10 条结果 ≈ 500 次搜索） | Hobby $19/月 5,000 credits；Standard $99/月 100,000 | [firecrawl.dev/pricing](https://www.firecrawl.dev/pricing) |
| **Parallel** | 每月 $5 额度（需绑卡）+ 注册最高 $80 奖励 | 搜索 $1/千次起（Turbo/Fast）、$5/千次（Basic/Advanced）；Extract $1/千 URL | [parallel.ai/pricing](https://parallel.ai/pricing) |
| **Jina** | 每个新 key 送 1,000 万 token；Reader 免 key 20 RPM | 按 token 计费；`s.jina.ai` 每次搜索固定 ≥ 10,000 token（按公开 token 价折算约 $0.50/千次搜索 ²） | [jina.ai/reader](https://jina.ai/reader/) |
| **Keenable** | 免 key：免费，每 IP 每小时 1,000 次。有 key：每月 100,000 次免费 | 超出免费额度后 $4/千次 | [docs.keenable.ai/pricing](https://docs.keenable.ai/pricing) |
| **SearXNG** | 自建免费（服务器成本自理） | — | [searxng.org](https://searxng.org) |

¹ Brave 官网营销页描述的是预付费 credits；$5/千次与每月免费额度由独立价格调查（[crawlfolio，2026-11-12 核验](https://crawlfolio.com/web-search-api-pricing/)）佐证，官方页面未提供机器可读的价格表。
² Jina 按 token 而非按次计费；每千次折算假设付费 token 约 $0.05/百万（第三方跟踪数据），请以你的 key 当前 token 包价格为准。

**Jev 智能判定**每个被分类的轮次额外产生一次小型 LLM 调用，费用由你配置的后端（TypeSafe System One、OpenRouter 或自有端点）计收。

个人使用完全可以跑在免费额度上：例如 Keenable 免 key + Tavily 每月 1,000 credits + Exa 每月 $10 额度。

## 接入远程网关

**客户端**上的 Kimi 插件加载 Skill、命令并运行钩子；**网关**执行搜索和网页读取，并持有搜索源凭据。搜索源配在网关主机上。远程访问用可信的 HTTPS 地址，网关继续只监听回环，由反代转发原始客户端地址（`X-Forwarded-For`），避免把反代请求当成回环直连。服务端通过 `KIMI_WEB_TOOLS_PASSWORD` 或 `web-tools/public-password` 配置网关密码；客户端的 `KIMI_WEB_TOOLS_GATEWAY_TOKEN` 填的是这个密码，不是搜索源 key。它也能访问仪表盘，只交给可信客户端，不要把值写进插件清单、共享的 `mcp.json` 或聊天记录。

### HTTP MCP 直连

1. 客户端如果已装 `web` 插件，在 TUI 执行 `/plugins mcp disable web s` 和 `/reload`，**只禁用自带的 stdio 服务**。没有安装插件就跳过。新增 HTTP 服务不会自动替换 `s`。
2. 把下面的例子合并到客户端的 `mcp.json`，保留已有服务。用户级文件是 `~/.kimi-code/mcp.json`（Windows：`%USERPROFILE%\.kimi-code\mcp.json`；自定义数据目录：`$KIMI_CODE_HOME/mcp.json`）。只想在当前项目用，就配在 `.kimi-code/mcp.json`，Kimi 可能要求信任该工作区。把 `https://search.example.com` 换成网关可达的地址，**保留 `/mcp`**。[桌面版](https://www.kimi.com/code/docs/en/kimi-code-desktop/settings-and-extensions.html#mcp)和 [CLI](https://www.kimi.com/code/docs/kimi-code-cli/customization/mcp.html)使用同样的文件格式。
3. 把 `KIMI_WEB_TOOLS_GATEWAY_TOKEN` 设到**启动 Kimi 的进程环境**里。`bearerTokenEnvVar` 填的是变量名，不是密码。改变量后若 Kimi 还在运行，完全退出，再从能读到变量的环境启动；只重载会话不会更新应用继承的环境。PowerShell 启动 CLI 时可用 `$env:变量名`；如果从桌面单独启动，请用 Windows 用户级环境变量，或从已经设置变量的环境启动 Desktop。不要只在网关主机或一扇不负责启动 Kimi 的终端里设置。

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

打开**新会话**。TUI 中用 `/mcp` 确认 `web-remote` 已连接、`plugin-web_s` 未启用，再用远程工具实际搜一次、读一次网页。网关登记了 `web_search`、`web_fetch`、`web_status`、`web_mode` 四个工具；例子仅启用前两个。`web_status` 只列出可用引擎，不暴露监听地址。`web_mode` 改的是**网关侧**搜索模式，纯 MCP 客户端不需要它。

### stdio 桥接远程网关

保留 `web` 插件及其 `s` 服务，不要在 `mcp.json` 再加一套重复的搜索工具。支持以下两种方式同时把 stdio 桥接和客户端钩子指向远程网关：

1. **客户端配置文件（推荐给 Windows / macOS 桌面端，插件重装或升级不会丢失）：** 创建 `$KIMI_CODE_HOME/web-tools/remote.json`（默认 `~/.kimi-code/web-tools/remote.json` 或 `%USERPROFILE%\.kimi-code\web-tools\remote.json`），权限建议 `0600`：

```json
{
  "url": "https://search.example.com",
  "token": "你的网关访问令牌"
}
```

`remote.json` 支持两个可选客户端隔离项：
- `"syncMode": false` — 搜索模式（`auto`/`smart`/`required`/`off`）仅由本机独立管理，不跟远端 `globalMode` 互相覆盖（多人共用网关推荐开启）。
- `"sendContext": false` — 调用远端 Smart（Jev）分类时不附带本机 `wire.jsonl` 短追问上下文，保护隐私。

2. **环境变量：** 把 `KIMI_WEB_TOOLS_GATEWAY_URL`（网关地址，不带 `/mcp`）和 `KIMI_WEB_TOOLS_GATEWAY_TOKEN` 设到启动 Kimi 的进程环境中（环境变量优先于 `remote.json`；显式设 `KIMI_WEB_TOOLS_GATEWAY_URL=""` 可强制回退本地模式）：

```bash
export KIMI_WEB_TOOLS_GATEWAY_URL="https://search.example.com"
kimi
```

```powershell
$env:KIMI_WEB_TOOLS_GATEWAY_URL = 'https://search.example.com'
kimi
```

重启 Kimi 并新开会话，`/mcp` 中应显示自带的 `plugin-web_s`。桥接与钩子走 `/web-tools/mcp/*`，反代需放行该路径（若同时开放仪表盘，请分配独立域名根路径如 `https://search.example.com`）。已配置远程地址时，远程请求失败**不会**回退到本机启动网关。

### 多人共享网关（最小权限访客令牌）

**不要把管理员密码（`KIMI_WEB_TOOLS_PASSWORD` / `public-password`）直接发给他人**：管理员密码拥有仪表盘与全部 `/web-tools/api/*` 权限（可改搜索源地址、凭据与全局模式）。

在网关主机上通过环境变量 `KIMI_WEB_TOOLS_CLIENT_TOKEN`（逗号分隔）或文件 `$KIMI_CODE_HOME/web-tools/client-token`（每行一个 token，建议 `0600`）签发**访客客户端令牌**，该令牌：
- **允许**：`web_search`、`web_fetch`、`web_status`（仅返回可用引擎名）、`evaluate-turn`（Smart 分类），以及读写自己会话的 `session_id` 模式。
- **禁止**：访问任何 `/web-tools/api/*`、登录仪表盘、修改 `globalMode`，以及查看其他用户的会话列表或历史决策。

共享网关建议在反代层（Nginx/Caddy/Cloudflare）配置频控，并让访客在各自 `remote.json` 中加上 `"syncMode": false` 与 `"sendContext": false`。

### 远程模式与 Smart（Jev 判定）同步

- **stdio 桥接 / `remote.json`：** 每轮用户发言时，`UserPromptSubmit` 会向远程网关调用一次 `POST /web-tools/mcp/evaluate-turn`，自动把远程网关的搜索模式（`auto`/`smart`/`required`/`off`）、`requiredEvidence`、`recognizeExternalWebTools`、`exemptWhenNoProvider` 与可用搜索源同步到客户端本地 `mode-state.json`。当处于 `smart` 模式时，Jev / Smart 分类器直接在**远程网关侧**使用网关配置、密钥和网络执行（避免客户端直连受地区限制返回 HTTP 451，同时保留客户端短追问上下文）。调用 `web_mode` / `/web:mode` 也会立即把最新模式镜像到本地。
- **HTTP MCP 直连（`web-remote`）：** 只接入工具，不会自动安装 Skill、斜杠命令或钩子。如果同时启用了插件但未配置 `remote.json` / `KIMI_WEB_TOOLS_GATEWAY_URL`，`web-remote` 在开启 `recognizeExternalWebTools` 时可作为外部搜索计入本轮，而插件自带的 `off` 拦截不会阻止这条独立 MCP 连接。

### MCP 排错

- **`Gateway exited before becoming healthy` / `Cannot find package 'linkedom'`：** 自带 stdio 工具尝试启动本地网关了。只用 HTTP 时，先确认 `s` 已禁用，再新开会话测试。确实要本地运行时，重新构建、按目录安装，查看 `$KIMI_CODE_HOME/web-tools/gateway.log`（默认 `~/.kimi-code/web-tools/gateway.log`）。缺 npm 依赖不是换个 Node 版本就能解决的。
- **HTTP `401` / `auth-not-configured`：** `401` 先检查实际运行的 Kimi 进程有没有拿到网关 token，不要打印它；`auth-not-configured` 则去网关侧设置密码。可用网关地址的 `GET /health` 区分网络与鉴权问题；健康检查通过不代表 token、MCP 初始化或搜索源可用。
- **工具重复 / `outside the tool choice`：** 在 `/mcp` 确认只保留选定的接入方式，再开新会话并使用它实际声明的工具名。远程状态或仪表盘回复里的 `127.0.0.1:18492` 是网关监听地址，不是客户端要打开的地址；客户端应使用配置的 HTTPS 网关地址。

## 独立网关

网关也可以脱离 Kimi Code 运行：

```bash
node ./bin/gateway-daemon.mjs            # 前台
node ./bin/gateway-daemon.mjs --daemon   # 后台守护进程
node ./bin/gateway-daemon.mjs ensure     # 未运行则启动
node ./bin/gateway-daemon.mjs status     # 状态 JSON
node ./bin/gateway-daemon.mjs stop
curl http://127.0.0.1:18492/health
```

包导出：`kimi-code-web-search`（宿主 API）、`kimi-code-web-search/gateway`、`kimi-code-web-search/storage`。可执行入口：`kimi-code-web-search-gateway`、`kimi-code-web-search-mcp`、`kimi-code-web-search-import-pi`。

## 已知限制

- **工具改名与老会话。** Kimi Code 在会话开始时冻结工具声明清单。插件工具名变更后（v0.4.0 曾把 `kimi-web-tools` 改为 `web`（仓库现名 `kimi-code-web-search`）），改名*之前*开的会话仍声明旧名；模型若调用新名，可能被严格校验函数名的上游网关拒绝。更新插件后请新开会话。
- **必搜模式依赖钩子加载。** 安装/更新后先 `/reload` 或新开会话再依赖强制执行。钩子执行出错时放行（fail open）。
- **Stop 门预算。** Kimi Code 每轮只给一次续写机会；第二次 Stop 一定放行。失败的研究如实报告为未验证，不会无限重试。
- **回执钩子是尽力而为。** Kimi Code 的 `PostToolUse` / `PostToolUseFailure` 仅观察不拦截，外部工具识别偶尔可能漏记。

## 开发

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test（Node >= 22.6）
npm run build        # 宿主（tsc）+ 客户端（esbuild）
```

## 许可证

[MIT](LICENSE)