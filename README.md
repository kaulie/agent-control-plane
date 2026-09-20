# Web Cursor (MVP)

A minimal web front-end for the Cursor Agent SDK. The goal is **not** an IDE —
it is to validate the core loop:

```
Task → Agent Run → Event Stream → Usage → Cost → Result
```

You chat with the Cursor agent from a browser, watch it execute in real time
(thinking, tool calls, file reads/edits, terminal), and see token usage and
estimated cost per Task — with a full execution timeline that survives a page
refresh.

## Architecture

```
Browser (React + Vite)
   │  WebSocket (/ws) + REST (/api)
   ▼
Agent Gateway (Fastify)
   │
   ▼
AgentProvider (adapter) ── CursorProvider ── @cursor/sdk
                                        (local agent: file system + terminal)
```

The Web UI never depends on the Cursor SDK directly. `@cursor/sdk` is imported
only under `backend/src/providers/cursor/`. New runtimes implement the same
`AgentProvider` interface and register in `createProvider`.

## Prerequisites

- Node.js **>= 22.5** (uses the built-in `node:sqlite`)
- A Cursor account with API access. The SDK authenticates via, in order:
  1. `CURSOR_API_KEY` env var (recommended)
  2. a previously stored SDK login (`Cursor.auth.login()`)

## Quick start

> All commands below run from the **project root** `/Users/gaolei/Projects/deepseek_web_cursor`
> (NOT from `web/` or `backend/`).

```bash
npm install

# Create backend/.env from the example and paste your API key:
cp backend/.env.example backend/.env
#   CURSOR_API_KEY=cur_live_...
```

### Option A — single process (simplest, no proxy)

One command builds the UI and starts the backend, which serves everything:

```bash
npm start
# open http://localhost:4211
```

### Option B — development (hot reload, two processes)

```bash
npm run dev
# open http://localhost:5174  (Vite proxies /api and /ws to the backend port)
```

The gateway port resolves as **`SERVICE_PORT` → `PORT` → `4211`**; the Vite dev
proxy follows the same order, so changing the port only requires setting it once:

```bash
SERVICE_PORT=4212 npm run dev      # backend + proxy both on 4212
```

If you prefer to run the two halves in separate terminals:

```bash
npm run dev:backend   # backend :4211 (or $SERVICE_PORT)
npm run dev:web       # frontend :5174
```

## Usage

1. Pick or create a **Project** in the sidebar (default: `Default`).
2. Click **+ New Task**: pick a **类型**（新功能开发 / 缺陷修复 / 问题定位 / 通用）and write
   the **任务描述**（必填 —— 它就是 agent 要干的事），optionally a title. On create the
   backend **自动把需求投递给 agent 并开跑**（见「任务意图」）；`POST /api/tasks` 需要
   `projectId` 与 `description`。
3. Type an instruction and press **Send**. Use the **Agent / Plan** dropdown
   next to the input to switch conversation mode (Plan focuses on planning;
   Agent can edit files and run tools). The last choice is remembered in the
   browser.
4. Watch the timeline stream real-time events (thinking → tool calls → file
   reads/edits → terminal → final answer).
5. The usage bar at the top shows tokens, cost, duration, model calls and tool
   calls. Refresh the page to see completed Tasks again.
6. The 🤖 button in the header opens the **Agent board**: one row per agent with
   its own name (the agent instance, independent of the task title), department
   (the task's project department), project, task title, completed conversation
   rounds, last activity, model, token spend and accumulated working duration. It
   can list only the current agent per task, every agent (including the ones
   replaced by a succession), or **one row per task** summed over every agent the
   task ever had, and clicking a task cell jumps to that task.
   A task does not keep one agent forever: a succession (mode change / unusable
   session) swaps in a new SDK agent, and each agent only owns its own runs — so a
   single agent row shows a much smaller number than the task's real workload
   (token-tune: 2 rounds on the current agent vs 38 across its 7 agents). Every
   agent row therefore carries the task's own totals (`taskTotals`) and shows
   `task 累计 …（N 个 agent）` next to its own rounds; the **task 汇总** scope is
   the place to read a task's cumulative numbers.
7. The 🕒 button in the header opens the **Agent timeline**: pick an agent (or
   use the “时间线” link on an Agent board row) and a time range (15 min … 30
   days, or a custom range) to see what that agent was doing —
   **thinking** (model-side events), **working** (tool-side events) and
   **idle** (no events). The state is drawn as **three flat, disconnected dotted
   rails at three heights** (top = thinking, middle = working, bottom = idle,
   `web/src/timeline-line.ts`): every state is its own horizontal dotted line and
   the rails are **never joined by vertical connectors** — the x position is the
   time and the height is the state, so no line has to drag itself up and down.
   Each rail is labelled on the left axis (`thinking 模型侧` / `working 工具侧` /
   `idle 无事件`), the three heights are only 12 apart (was 20) and the line is
   painted as dots (`stroke-dasharray: 0.1 4.6` + round caps), so the whole band
   stays light instead of reading as a filled band. Stretches with no events
   for too long are overlaid with an amber dashed line. The user's input events
   are drawn on their own lane and listed in a table, plus a per-run breakdown
   (thinking/working time, tool & model calls, the message that triggered it).
   Hover any segment/run/marker for exact times (the rails keep per-segment hit
   areas); wide ranges are aggregated into time buckets, which are drawn on the
   rails at their dominant state.
   The range is **automatic by default**: it follows the selected agent's own
   last activity (`lastActiveAt`, not limited by the window), so picking an agent
   that has not run for a day never lands on an empty window. If even the longest
   preset does not cover an agent's activity, the page widens the window itself
   and says so; if you picked a range by hand and it turns out to contain no
   events, the page says which agent was last active when and offers a
   one-click “查看那段时间”. Only a range you pick yourself is remembered.

> The agent runs in the `workspace/` directory by default (set `AGENT_WORKSPACE`
> in `backend/.env` to change it). Each run is billed to the authenticated
> Cursor account.

### Agent 工作区（每个 agent 一个目录）

新建任务时网关会**先给这个 agent 分配一个 id**（`agent-<16hex>`），并把它的工作区建在

```
<AGENT_WORKSPACE_ROOT>/agent-<agentid>/
```

—— 目录名**就是** agent id（不再有 `<project>/<taskId>` 那层），所以「这个目录属于哪个
agent」不用查库；`- workspace:` 这一行（启动简报）注入的就是它，agent 一开工就知道自己在哪。

| 环节 | 行为 |
| --- | --- |
| 建任务（`POST /api/tasks`） | 分配 `agent_id`（落库 + `agent_preallocated=1`）、`mkdir` 工作区；显式传 `workspace` 时仍以它为准（不建默认目录） |
| 首个 run | 预分配 id 走 `RunInput.preallocatedAgentId`，**开新会话**（不是 resume）：Cline 的宿主会话 id 由调用方指定，所以直接用它 → `task.agentId` / 目录名 / 看板上的 agent 名完全一致；Cursor 的 SDK 自己生成 id → 网关绑定真实 id，目录名保持预分配值（工作区**不搬家**） |
| 会话建起来后 | 预分配标记清掉 → 后续 run 回到正常 resume 路径 |
| 老任务 / fork | 老任务没有预分配 id（行为逐字不变）；fork 沿用源任务的同一个工作区（否则丢本地 clone / 未提交改动） |

## 任务意图（类型 + 目标 + 描述 + 自动投递）

**问题**：以前任务只有一个标题，意图全靠对话一轮轮猜 —— agent 第一轮经常先问一遍
"你到底要什么"，甚至直接做偏。

现在每个任务有三个意图字段（`tasks` 表 + `Task` API）：

| 字段 | 说明 |
| --- | --- |
| **`description`（任务描述）** | 需求原文。**新建必填**（没有描述 → `POST /api/tasks` 400），创建后可在主界面的「任务意图」面板上改（`PATCH`），但**不允许改成空**（它是任务的必填属性）。 |
| **`taskType`（任务类型）** | `feature` 新功能开发 / `bugfix` 缺陷修复 / `diagnose` 问题定位 / `general` 通用（缺省）。**它只是分类标签，不改变 agent 的行为** —— 用途是列表/面板徽标、创建时切换描述模板、落库供以后按类型统计；历史任务全是 `general`，行为与以前逐字节一致。 |
| **`goal`（任务目标）** | `merge` 合入主分支（**默认**）/ `deploy` 合入主分支并部署上线。和前两个不同，**它会改变 agent 的交付动作**：`merge` = 做完开 PR、检查通过后由 agent 自己合入 `main` 即止（不部署）；`deploy` = 在 `merge` 之上再走部署平台把这次改动部署上线。目标会写进「系统投递」的需求消息（多一行 `目标：…`）与**会话简报**（`- goal: …`，重启 / 轮转 / fork 都不丢）。历史任务与内部任务（watchdog 崩溃分析）**没有目标** → 简报里不加这一行，保持老行为「开完 PR 就停」（不 merge、不部署）。 |

三条动线：

1. **新建**（`CreateTaskDialog`）：选类型 → 选目标（默认「合入主分支」，另一项「合入主分支并
   部署上线」）→ 描述框按类型给 placeholder/模板（"什么算做完"比
   "要做什么"重要）→ 描述为空时「创建并开始」按钮不可点；标题可留空（用描述首行兜底）。
2. **自动投递**：`POST /api/tasks` 创建成功后会**自动把描述当成第一条消息投递给 agent**，
  它随即开跑（`payload.deliveredBy: "system"` + `kind: "task_intent"`，时间线上渲染成
  「⚙️ 系统投递 · 需求」卡片，不会冒充用户发言）。这次投递复用 `sendMessage`，所以
  **并发上限 / 排队 / 部署 drain** 全部照常：槽位满时它是 `queued`，不是失败。
  没有描述的内部任务（watchdog 崩溃分析等）跳过投递；`fork` 也不重复投递。
3. **修正**：主界面聊天框上方的「任务意图」面板（pin 在输入框上方，可折叠）显示
   类型 + 目标徽标 + 标题 + 描述 + 投递状态，点「✎ 编辑」就地修改（目标也能改；老任务显示
   「仅开 PR」，**不会**因为改了标题就悄悄给它加上目标）。⚠️ 修改只进**下一次**会话
   （重启 / 轮转 / fork）的简报，正在跑的 agent 看不到 —— 时间线会留一条
   `status: task_intent_updated` 说明这一点，不假装 agent 立刻知道。

描述同时进**会话简报骨架**（`## 任务描述`，上限 2000 字符）：会话因重启/轮转被重建后，
需求还在（事件流里的首条需求可能被"保尾部"裁掉，骨架不会）。
目标同样进骨架（`- goal: …`），并且改写简报里那句
「Do not merge the PR and do not deploy unless the user asks.」：有 `merge` / `deploy` 目标时
它变成「用户建任务时已经授权合入（／再部署）」，但**风险仍要停** —— 检查不过 / 冲突 / 有疑问先问人。
没有目标的老任务，简报里既没有 `- goal:` 行，也保留原来那句话（行为不变）。

## Cost

计费是**独立模块** `backend/src/billing/`（见该目录的 README），钱只按一张表算：
SQLite 表 **`billing_rules`**（模型价目 + 高峰/空闲时段规则，可改价、可停用、改完立即生效）。

- 主口径 = 计费表算出来的钱：写在 `run.cost_json.estimatedCents`（USD cents）+
  逐项明细 `cost_json.billing`（规则 id / 时段 / 本币金额 / 分项），本币金额是账单口径；
- 对比口径 = provider / SDK 自己上报的 `totalCost`：写在 `cost_json.chargedCents`，**只作对比**
  （实测 SDK 上报 ≈ $15，而按 DeepSeek 官方价目表算 ≈ ¥297 ≈ $42，不是一套价卡）；
- 页面（`UsageBar`）把两个值**分开显示**，不要相加；
- **实际成本的取值顺序 = 计费表 > provider/SDK 上报 > 旧估算**（`cost_json.costSource`）：
  没有规则命中的 run（例如 cursor：价目表还没入库）实际成本**就是上报值**；
  连上报值也没有（cursor 的 SDK 就不返回成本）才用旧估算兜底 ——
  这两种情况下两个格子都显示**同一个数**，两个字都有值（不会出现「—」）；
- 旧的两张代码价目表（`backend/src/usage/pricing.ts`、cline 的 `DEEPSEEK_PRICING`）降级为
  兜底估算，只在「没规则命中 / 没注入计费模块」时用。

历史 run 想按新表重算：

```bash
sqlite3 ~/runtime/web-cursor/backend/data/web_cursor.db ".backup /tmp/wc-copy/web_cursor.db"
npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy           # dry-run
npx tsx backend/scripts/recompute-costs.mjs --data-dir=/tmp/wc-copy --apply   # 落库
```

## Context（上下文体量 + 透明化）

会话是**只增不减**的消息列表，长到模型窗口（deepseek-v4-* = 1,000,000）就会**永久卡死**
（pdf-reader 实测：最后一次调用 prompt = 1,046,240，下一次请求就越过上限，SDK 的"压缩后重试"
也救不回来）。所以：

- 详情页 `UsageBar` 下方有一条 **Context**：`Context 39.1% · 390.6K / 1.00M · 约 28 轮后到 85%`
  + 最近每轮 run 的增量小柱图（黄柱 = 那一轮换了会话）；70% 黄 / 85% 红 / ≥100% 标 over；
- 口径：`tokens` = **最近一次模型调用的 prompt**（cline 的 usage 是 run 内累计值，单次 = 相邻两条的差）。
  ⚠️ 别和 `stats.inputTokens`（跨调用累加，38.9M）混；provider 推不出体量时（cursor）
  显示「未知 + 原因」，**不猜数**；
- 模型窗口从 provider 的模型目录读（`@cline/llms`），查不到就是"窗口未知"；
- **防炸三条线**：85% 提示 fork（人决定）→ 88% 系统兜底**自动轮转会话**（换会话 + 简报，时间线写明
  原因与当时占比）→ 90% 由 SDK 的 **compaction** 自己压（已启用，`CLINE_COMPACTION=0` 可关；
  探针发现它是 opt-in 的：不显式打开等于没有 `prepareTurn`，长会话只能撞硬上限）。
  开关：`CONTEXT_AUTO_ROTATE=0` 关掉自动轮转（只留提示与可操作报错）；
- **两个增强默认关**（要开就设环境变量）：
  `CONTEXT_DIGEST=1` = 让模型把历史压成交接摘要（fork / 轮转时替代原始历史；失败自动回退原始历史，
  生成时留 `status: digest` 事件、原文可读）；`CLINE_COMPACTION=agentic` = 用 LLM 摘要式压缩
  （默认 `basic` 截断投影；summarizer 沿用本 provider 凭据，缺 key 退回 basic）。
- **上下文将满（≥85%）= fork 出口**：UsageBar 下方常驻一条提示 + 「Fork 新 task」按钮；
  你**下一次发言**时会先弹窗（Fork / 仍然发送 / 不再提醒 / 取消）—— 不做"替用户决定"的默认动作。
  Fork 继承工作区与模型并带上最近历史，原 task 时间线留痕，也会显示 `已 fork → #xxx`；
- **透明化契约**：任何改变 agent 上下文/记忆的动作都必须写一条用户可见的时间线消息 +
  一条可审计的事件 —— 已落地三类：网关重启/会话失效 → `session_reset`；切模式 seed →
  `agent_succession.seededTokens`（以前只有条数 `1630`，看不出搬走了 ≈1M 上下文）；新会话简报 →
  `run_started.bootstrap*`（含原文，能回答"模型看到了什么"，且超预算时**保尾部**不再整段砍掉
  「近几轮 run 结论」）。

细节与后续计划见 [`backend/src/context/README.md`](backend/src/context/README.md)。

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | liveness |
| GET | `/api/auth` | SDK auth check (`Cursor.me()`) |
| GET | `/api/models` | available models |
| GET | `/api/projects` | list Projects（含各自的 `department`，供左栏「所属部门」显示） |
| GET | `/api/projects/:id` | 单个 Project（形状 = 列表里那一项：`name` / `department`）；不存在 → 404。**没有 `gitRepoUrl`**（老字段已删：接口不返回、UI 不展示） |
| POST | `/api/projects` | create Project `{ name, department }`；`department` **必填**（缺失 → 400），与项目同一次写入（body 里传老的 `gitRepoUrl` 会被忽略） |
| PATCH | `/api/projects/:id` | rename Project `{ name }` |
| GET | `/api/org/departments` | 项目「所属部门」候选列表（取自 organization 服务；不可达时 `available: false`，`?refresh=1` 绕过缓存） |
| GET | `/api/projects/:id/service-repos` | **注入 agent 的仓库地址**：project → 所属部门（组织 id）→ 服务中心 `GET /v1/orgs/{orgId}/services`（含各服务的 `gitRepoUrl`）；`repos: null` = 没部门/没配客户端；不可达时 `repos.available=false`；`?refresh=1` 绕过 30s 缓存 |
| GET | `/api/projects/:id/settings` | Project settings (`runtime` / `department` + 只读 `cwdRules`) |
| PATCH | `/api/projects/:id/settings` | 更新 Project settings `{ runtime?, department? }`（`department` 传空即清除） |
| GET | `/api/tasks` | list Tasks (+ stats); optional `?projectId=` |
| POST | `/api/tasks` | create Task `{ title?, description, taskType?, goal?, workspace?, model?, projectId? }` —— **`description` 必填**（缺失/纯空白 → 400，超 4000 字 → 400），`taskType` ∈ `general\|feature\|bugfix\|diagnose`（非法 → 400），`goal` ∈ `merge\|deploy`（非法 → 400；缺省 `merge`），`workspace` 缺省 = `<AGENT_WORKSPACE_ROOT>/agent-<agentid>`（agent id 建任务时预分配，见「Agent 工作区」）。创建成功后会**自动投递需求**并开跑（见「任务意图」） |
| GET | `/api/tasks/:id` | Task detail（task + runs + stats + context + forkedTo + **`project`**）；`project` = 任务所属项目（名字 / 所属部门快照 `department.departmentId`+`departmentName`，**不含仓库地址**），项目的实时部门目录见 `GET /api/org/departments`；项目已被删掉时缺省 |
| PATCH | `/api/tasks/:id` | 改任务意图 `{ title?, description?, taskType?, goal? }`（**描述不允许改成空** → 400；非法类型 → 400；`goal` 非法 → 400，传 `null` = 清掉目标）或回写 PR 链接 `{ prUrl }`；成功 publish `task_updated`，改意图时时间线留 `status: task_intent_updated` |
| GET | `/api/agents` | **Agent 看板**：`?scope=current\|all\|task`（默认 `current` = 每个 task 当前那个 agent；`all` = 连同被 succession 替换掉的 agent；`task` = 每个 task 一行、数字跨它历史上**所有** agent 相加）、`?projectId=` 过滤。每行带 `agentName`（由 agent id 归一化，独立于 task 标题）/ 所在部门（task 所属 project 的部门）/ project / task 标题 / `completedRounds`（累计完成对话轮次 = finished 的 run 数）/ 最后活跃时间 / 模型 / token 消耗 / 累计工作时长；另带 `taskTotals`（`completedRounds` / `runCount` / `totalTokens` / `durationMs` / `modelCalls` / `toolCalls` / `agentCount`）—— per-agent 的数字在 succession 之后会明显小于 task 的真实工作量，所以两个口径都给。`scope=task` 的行另有 `taskScope: true` / `currentAgentId`（`agentId` 为空，因为整行代表 task） |
| GET | `/api/agents/:agentId/timeline` | **Agent 时间线**：某段时间内这个 agent 的工作状态与用户输入。`?from=&to=`（ISO，缺省最近 1 小时，跨度上限 30 天）、`?projectId=`。返回 `segments`（idle / thinking / working，首尾相接铺满窗口）或 `buckets`（跨度大时按时间桶聚合）+ `markers`（用户输入 / run 起止 / agent 替换 / 疑似停滞）+ `runs`（每轮 run 的 thinking·working 时长、工具·模型调用、触发输入）+ `totals`（活跃占比等）+ `note`（判定口径）+ `lastActiveAt`（这个 agent 自己的最近活跃时间，**不受查询窗口限制**：窗口里没有事件时前端靠它区分「窗口选错了」和「这个 agent 没动过」）+ `agentRunCount` / `agentCompletedRounds`（这个 agent 自己的累计，同样不限窗口：页面上的「run 轮次」只算窗口内） |
| GET | `/api/tasks/:id/events` | event timeline (`?after=<seq>`) |
| POST | `/api/tasks/:id/fork` | **上下文将满时的分流**：fork 成新 task（继承 project / provider / model / **taskType + goal + description** / **同一个 workspace** / prUrl，记 `forkedFrom`），原 task 时间线留一条 `status: forked` 提示；历史不复制事件，改为在新 task 的启动简报里带一份（`carried`，带 `[fork:*]` 前缀）。**不**自动重复投递需求（源会话已经投过） |
| GET | `/api/tasks/:id` | Task detail（含 `stats` / `context` / `forkedTo`） |
| POST | `/api/tasks/:id/messages` | send `{ message, mode?, images? }` → starts an Agent Run (`mode`: `agent` \| `plan`, default `agent`) |
| POST | `/api/tasks/:id/stop` | stop the in-flight Agent Run |
| GET | `/api/billing/rules` | **计费规则表**（`billing_rules`）：每个模型的峰谷价目 + 错峰窗口（UTC 分钟） |
| PUT | `/api/billing/rules/:ruleId` | 新增 / 覆盖一条计费规则（校验：数值 ≥ 0、分钟 0–1439、设了 `offpeakWindow` 必须给 `offpeak` 价；400 返回原因） |
| DELETE | `/api/billing/rules/:ruleId` | 删一条规则（内置行下次启动会补种，想停用请把 `enabled` 置 0） |
| GET | `/api/stats/token-usage` | 按 provider/model 粒度、按时间统计总 token 消耗量（`?granularity=hour\|day\|week&projectId=&from=&to=`；缺省按天） |
| WS | `/ws` | real-time push: `agent_event`, `task_updated`, `task_created`, `project_created`, `project_updated` |

### 写操作必须校验页面版本

前端发起的所有写操作都要证明「发起写的页面版本」与「项目当前版本」一致，否则**拒绝落地**：

- 前端每个写请求都带 `x-ui-version`（= 构建时注入的 `__APP_VERSION__`）；提交前先 `GET /health`
  比对，不一致时**不发请求**，直接提示「请先刷新页面」（`web/src/api.ts` 的 `write()`）。
- 网关侧 `backend/src/http/ui-version.ts` 用 `onRequest` 钩子校验**所有** `/api/*` 写请求，
  与 `version()`（磁盘 `VERSION`，即 `/health` 的 `version`）比对：
  - 缺 `x-ui-version` → `428`；值不一致 → `409`；
  - body：`{ code: "ui-version-mismatch", clientVersion, serverVersion, mustRefresh: true, error }`；
  - 钩子先于 handler 执行，被拒绝的写**不会生效**（前端弹「页面版本已过期，本次提交被拒绝」+「立即刷新」）。
- 不校验：非写方法、非 `/api/` 路径、`/api/ops/*`（部署平台的 graceful 契约，非浏览器发起）。
- `curl` 手工调写接口时要自己带：`-H "x-ui-version: $(cat VERSION)"`（在 runtime 目录下执行）。

Each Task belongs to a Project (`projectId`). On first boot a default project
`Default` (`project-default`) is created and existing tasks are attached to it.

## CI

Pull requests and pushes to `main` run [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
`npm ci` → typecheck → build → **contract（`npm run openapi:check`）** → `npm test`.
Compiled `backend/dist` and `web/dist` are uploaded as GitHub Actions artifacts and
expire after **7 days** (Actions run → Artifacts). This does not deploy: every deploy is
triggered from the independent deployment platform (`:4220`), which packages the merged
`main` commit and restarts the service. This repo has no deploy entry point.

## 注入 agent 的仓库地址（服务中心；应用里不再有项目级 `gitRepoUrl`）

agent 启动简报里那段「仓库地址」按下面这条链路查出来：

```
project → project.department.departmentId（组织 id）
        → 服务中心 GET /v1/orgs/{orgId}/services（该组织下登记的所有服务，含 gitRepoUrl）
        → 写进 Task bootstrap 的「## Workspace isolation → Injected git repositories」
```

- 单一真源 = 服务中心：服务登记时填的 `gitRepoUrl` 改了，下一个新建会话的 agent 就看到新的
  （**应用里已经没有项目级 `gitRepoUrl`**：接口不返回、UI 不展示，避免两个真源打架）。
- 简报里最多逐个列 12 个仓库（超出的折成一句「另有 N 个」），并写明来源
  （`GET /v1/orgs/<orgId>/services` + 组织名），便于 agent 自查。
- 服务中心不可达 / 项目没有所属部门 → 简报退回兜底文案「按需自己 clone」
  （没有项目级仓库地址可以回落）。
- 想先看「这个项目会被注入什么」：`GET /api/projects/:id/service-repos`（`?refresh=1` 绕过 30s 缓存）。
- **调试时不用查库**：任务详情页顶部常驻一条「基础信息」（`Task` / `Project` / `Org`，绑定后还有
  `Agent`），项目设置页头部标了 `Project` / `Org` —— 都是**完整 id**，点一下即复制。
  这里的 `Org` 就是本节的 `project.department.departmentId`（项目没设部门 → 显示「未设置组织」，
  不会编一个假 id）：`web/src/components/TaskIdsBar.tsx`。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVICE_REGISTRY_API_URL` | `http://127.0.0.1:4240` | 服务中心地址（注入查询用） |
| `SERVICE_REGISTRY_TIMEOUT_MS` | `3000` | 查询超时；超时 = 本次退回兜底文案（不阻塞开会话，结果按 30s 缓存） |

实现：`backend/src/service-registry.ts`（只读客户端，从不抛异常）+ `backend/src/task-context.ts`
（`injectedRepoLines`）+ `backend/src/gateway/gateway.ts`（`orgServicesFor`）。

## 服务中心契约登记（Node 对等方案）

本服务把自己登记进 [服务中心](https://github.com/kaulie/service-registry)（`127.0.0.1:4240`）：
注册的是**对外 API 契约 + 实例集合**，一次性调用、幂等、运行时零依赖（服务跑起来之后跟
注册中心没有任何连接）。

Go 服务的做法是 swag 注解 + `client/ci/register-go-service.sh`（内含 `swag init`）。
本服务没有代码生成器，用的是对等物 —— **契约提交进仓库，CI 保证它跟路由一致**：

```
backend/src/http/route-meta.ts   ← 「注解」的唯一真源（每个路由的 summary/tags）
        +  backend/src/http/routes.ts（真实路由表）
        ├── npm run openapi:gen ──▶ api/openapi.json ──┐（提交进仓库 = swag 产物的对等物）
        │                                              │
        └── npm run openapi:check（CI：忘更新就红）      └── bash scripts/register-contract.sh
                                                              （一行：读契约 + 幂等上报）
```

| 命令 / 开关 | 作用 |
| --- | --- |
| `npm run openapi:gen` | 从路由 + `route-meta.ts` 重新生成 `api/openapi.json` |
| `npm run openapi:check` | 双向校验 + 检查有没有忘提交（CI 里跑，红了就说明接口改了契约没跟上） |
| `npm run openapi:list` | 只列真实路由（排查用） |
| `npm run contract:register` / `bash scripts/register-contract.sh` | 幂等上报（服务 + 实例）；`--dry-run` 只探活 + 打印命令 |
| `build.sh` 末尾 | 发版时自动跑一次（`REGISTER_CONTRACT=0` 关；`REGISTER_CONTRACT_STRICT=1` 让失败致命） |

一致性是**双向**的（等价于服务中心自己那条「路由 ↔ 自述契约」检查）：路由表里有、契约里
没有（且没进 `OPENAPI_EXCLUDE` 说明原因）→ 生成/检查直接失败；契约里写了不存在的接口 →
同样失败。所以「新加接口忘了写契约」和「删了接口忘了清契约」都拦得住。

登记默认值（都在 `scripts/register-contract.sh` 顶部，可用环境变量覆盖）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVICE_NAME` | `agent-control-plane` | = 仓库名（服务中心里已登记的那一条，不再另开一条） |
| `REGISTRY_URL` / `REGISTRY_NS` | `http://127.0.0.1:4240` / `default` | 注册中心地址与命名空间 |
| `INSTANCES` | `127.0.0.1:${SERVICE_PORT:-4211}` | 实例集合（声明式整组对齐，逗号分隔可多个） |
| `DEPARTMENT_ID` | `D0005`（AI研发部） | 与项目设置里选的部门一致；服务端会拿组织接口的目录对齐 |
| `VERSION` / `OWNER` / `HEALTH_PATH` | `${APP_VERSION}` / `kaulie` / `/health` | 发版版本 / 归属人 / 健康检查路径 |

> ⚠️ 注册中心**只绑 127.0.0.1**（写接口现在默认开放，所以刻意不暴露到网络）：
> 这条命令要么跑在本机（`build.sh` / 手动），要么跑在 self-hosted runner 上；
> GitHub-hosted runner 够不到，CI 里只跑 `openapi:check`（不写库）。


## Project layout

```
backend/src/
  index.ts        server bootstrap
  config.ts       env config (.env)
  store/db.ts     SQLite persistence (projects / tasks / runs / events / stats)
  gateway/        Task → Run → Event → Usage orchestration
  providers/      AgentProvider adapter + createProvider + cursor/ (@cursor/sdk)
  timeline.ts     agent 时间线：事件 → idle / thinking / working（+ 用户输入 marker）
  usage/          token 口径（inclusive/disjoint）+ 兜底估算价目
  billing/        计费模块：billing_rules 表驱动的价目/时段规则（见该目录 README）
  context/        上下文体量口径 + 模型窗口 + token 估算（见该目录 README）
  http/ ws/       REST + WebSocket
  http/route-meta.ts  对外契约的「注解」真源（summary/tags，见「服务中心契约登记」）
api/openapi.json  生成的对外契约（提交进仓库；swag 产物的对等物）
scripts/register-contract.sh   服务中心登记的一行入口（CI / 发版用）
web/src/          React UI (Chat / Timeline / UsageBar / TaskList + Projects)
  usage-cost.ts    成本两个口径的文案（计费表本币 vs SDK 上报美元，分开显示）
  timeline-line.ts  状态点线的几何（idle / thinking / working → 三条互不相连的水平线）
  board-format.ts   看板数字口径文案（per-agent vs 整个 task，两处都写清）
web/scripts/     前端纯逻辑测试（点线几何 + SVG 渲染，由 backend 的 run-tests 统一起跑）
workspace/        legacy relative sandbox (旧版；新 agent 的工作区是 `<AGENT_WORKSPACE_ROOT>/agent-<agentid>/`)
```
