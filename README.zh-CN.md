# Kimi Web Tools

[English](README.md) | **中文**

面向 [Kimi Code CLI](https://www.kimi.com/code) 的多源联网搜索/网页读取插件：按会话生效的**搜索模式**策略、**Jev 智能判定**、小红书 / X 平台研究，以及本地 **Web UI 仪表盘**。

插件本身免费开源（MIT）。搜索 API key 由你自备；多数厂商的免费额度足够个人使用，详见[价格](#价格)。

![搜索模式菜单](assets/search-mode-menu.png)

## 功能

- **`web_search`** —— 一个工具打通可配置的搜索源池：Exa、Tavily、Brave、You.com、Firecrawl、Parallel、Jina、Keenable、自建 SearXNG，以及自定义源（Tavily 兼容、SearXNG JSON、通用 JSON API）。多 key 池、健康感知轮换、额度跟踪、自动降级。路由策略：`ordered`（顺序）、`round-robin`（轮询）、`random`（随机）。可选 `provider` 参数指定优先尝试的源，用于多源交叉验证。
- **`web_fetch`** —— 任意公开 URL → 干净可读的 Markdown/正文，独立的读取链（`fetchOrder`），兜底为内置 HTTP。小红书和 X 的帖子 URL 会返回完整正文与热门评论。
- **平台内搜索** —— 查询加前缀 `小红书:` 或 `X:` 直接在平台内搜索（需要在仪表盘登录浏览器会话）。网关会在输入平台搜索框前去掉前缀。
- **四种搜索模式**，通过 Kimi Code 生命周期钩子强制执行：
  - `auto`（智能联网）—— 按需联网，其余情况直接依据上下文回答。
  - `smart`（Jev 判定）—— 由小型分类器逐轮判定是否需要联网。后端支持 TypeSafe System One（默认模型 `jev-latest`）、OpenRouter、任意 OpenAI 兼容端点。出错/超时默认放行（fail open），配置 `failOpen: false` 则改为升级成必搜。
  - `required`（始终联网）—— 每个用户轮必须先完成一次真实搜索才能结束回答。默认只有搜索算数（`requiredEvidence: "search"`），切到 `"search-or-fetch"` 后读取 URL 也算。识别到的外部 web/MCP 搜索工具同样计入。没搜或全部失败时，Stop 门只纠偏一次，随后放行并要求把失败如实报告为未验证——不会死循环。
  - `off`（关闭联网）—— 屏蔽本插件的联网工具；不影响其他插件。
- **防幻觉提示词纪律** —— 围绕请求真正依赖的事实去搜、用一手来源核验、失败的源不重试而是换源、绝不凭记忆补全（"未搜到不等于不存在"）。
- **Web UI 仪表盘**（`http://127.0.0.1:18492`）——  provider key 与额度、拖拽排序路由、Smart/Jev 面板（含分类器测试）、全局/会话级模式切换、平台登录、明暗主题、中英文界面。
- **Pi 导入** —— 一条命令从本地 Pi agent 配置（`always-search.ts` + `pi-web-access`）迁移 API key、端点、路由和搜索模式。
- **子代理感知** —— 正确处理子代理活动、系统触发轮和会话清理，必搜门不会在后台轮上误伤。

## 环境要求

- Kimi Code CLI（支持插件的近期版本）。
- Node.js ≥ 22.6（推荐 22 LTS+；开发/测试脚本使用 `--experimental-strip-types`）。
- 至少一个搜索源 API key，或自建 SearXNG。Keenable 无 key 也能用（限流）。
- 可选：本地 Chrome/Chromium/Edge，用于小红书 / X 浏览器会话。

## 安装

### 方式 A —— 从 GitHub 安装（推荐）

在 Kimi Code TUI 中：

```
/plugins install https://github.com/kim1232aa/kimi-code-web-search
/reload
```

然后**新开会话**（`/new`）。插件变更只在 `/reload` 或新会话后生效。

> 注意：编译产物（`lib/`、`dist/`）不入库。若安装副本缺少 `lib/`，入口脚本会回退为直接运行 TypeScript 源码，需要 Node ≥ 22.6 的类型剥离能力。如启动异常，请改用方式 B。

### 方式 B —— 本地构建后按路径安装

```bash
git clone https://github.com/kim1232aa/kimi-code-web-search.git
cd kimi-code-web-search
npm install
npm run build
```

然后在 Kimi Code TUI 中：

```
/plugins install /绝对路径/kimi-code-web-search
/reload
```

本地安装会被复制到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，CLI 始终运行这份托管副本。修改源码后需要重新构建并重新安装。

### 首次使用

1. 运行 `/web:dashboard`（或直接打开 `http://127.0.0.1:18492`）。网关守护进程会在首次使用时自动启动。
2. 在仪表盘里添加至少一个搜索源 API key，或在启动 Kimi Code 前导出环境变量：

   ```bash
   export WEB_TOOLS_EXA="..."        # 另有：WEB_TOOLS_TAVILY、WEB_TOOLS_BRAVE、
   export WEB_TOOLS_KEENABLE="..."   # WEB_TOOLS_YOU、WEB_TOOLS_FIRECRAWL、
                                     # WEB_TOOLS_PARALLEL、WEB_TOOLS_JINA、WEB_TOOLS_SEARXNG
   ```

3. 用 `/web:status` 检查一切就绪。

Key 保存在 `$KIMI_CODE_HOME/web-tools/credentials.json`（权限 `0600`），日志、状态输出和导入摘要都不会打印明文。

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
| `mcp__plugin-web_s__web_search` | 跨搜索源池的网页/平台搜索；可选 `provider` 指定优先源 |
| `mcp__plugin-web_s__web_fetch` | URL → 干净 Markdown；小红书 / X 帖子返回全文与评论 |
| `mcp__plugin-web_s__web_mode` | 查看 / 设置 / 循环切换搜索模式 |
| `mcp__plugin-web_s__web_status` | 网关健康、路由链、key 池、额度、平台会话 |

### 斜杠命令

- `/web:mode [auto|smart|required|off|toggle]` —— 查看或切换模式（`smart` 也接受 `jev`、`自适应`、`智能判定`）。
- `/web:status` —— 网关、模式、路由、额度、平台登录摘要。
- `/web:dashboard` —— 确保网关运行并给出仪表盘地址。

轮中切换模式从下一个用户轮生效；`off` 立即屏蔽本插件的联网工具。

### Skill

内置 `web-research` skill 教会代理研究工作流：围绕具体主张构造查询、多角度子查询、失败换源不重试、用 `web_fetch` 核验一手来源、如实报告 `未验证`。

## 配置

所有配置都可在仪表盘完成；文件位于 `$KIMI_CODE_HOME/web-tools/`（`config.json`、`credentials.json`、`mode-state.json`、`gateway.json`）。

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

- **工具改名与老会话。** Kimi Code 在会话开始时冻结工具声明清单。插件工具名变更后（v0.4.0 曾把 `kimi-code-web-search` 改为 `web`），改名*之前*开的会话仍声明旧名；模型若调用新名，可能被严格校验函数名的上游网关拒绝。更新插件后请新开会话。
- **必搜模式依赖钩子加载。** 安装/更新后先 `/reload` 或新开会话再依赖强制执行。钩子执行出错时放行（fail open）。
- **Stop 门预算。** Kimi Code 每轮只给一次续写机会；第二次 Stop 一定放行。失败的研究如实报告为未验证，不会无限重试。
- **平台会话**（小红书 / X）依赖本地浏览器且可能过期，需要时在仪表盘重新登录。
- **回执钩子是尽力而为。** Kimi Code 的 `PostToolUse` / `PostToolUseFailure` 仅观察不拦截，外部工具识别偶尔可能漏记。

## 开发

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test（Node >= 22.6）
npm run build        # 宿主（tsc）+ 客户端（esbuild）
```

依赖浏览器的测试（`browser-lifecycle`、`browser-session`）需要本地 Chrome/Chromium，无头环境下跳过。

## 许可证

[MIT](LICENSE)