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
2. Click **+ New Task** (or create one via `POST /api/tasks` with `projectId`).
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
| POST | `/api/projects` | create Project `{ name, department, gitRepoUrl? }`；`department` **必填**（缺失 → 400），与项目同一次写入 |
| PATCH | `/api/projects/:id` | rename Project `{ name }` |
| GET | `/api/org/departments` | 项目「所属部门」候选列表（取自 organization 服务；不可达时 `available: false`，`?refresh=1` 绕过缓存） |
| GET | `/api/projects/:id/settings` | Project settings (`runtime` / `department` + 只读 `cwdRules`) |
| PATCH | `/api/projects/:id/settings` | 更新 Project settings `{ runtime?, department? }`（`department` 传空即清除） |
| GET | `/api/tasks` | list Tasks (+ stats); optional `?projectId=` |
| POST | `/api/tasks` | create Task `{ title?, workspace?, model?, projectId? }` |
| GET | `/api/tasks/:id` | Task detail (task + runs + stats) |
| GET | `/api/agents` | **Agent 看板**：`?scope=current\|all\|task`（默认 `current` = 每个 task 当前那个 agent；`all` = 连同被 succession 替换掉的 agent；`task` = 每个 task 一行、数字跨它历史上**所有** agent 相加）、`?projectId=` 过滤。每行带 `agentName`（由 agent id 归一化，独立于 task 标题）/ 所在部门（task 所属 project 的部门）/ project / task 标题 / `completedRounds`（累计完成对话轮次 = finished 的 run 数）/ 最后活跃时间 / 模型 / token 消耗 / 累计工作时长；另带 `taskTotals`（`completedRounds` / `runCount` / `totalTokens` / `durationMs` / `modelCalls` / `toolCalls` / `agentCount`）—— per-agent 的数字在 succession 之后会明显小于 task 的真实工作量，所以两个口径都给。`scope=task` 的行另有 `taskScope: true` / `currentAgentId`（`agentId` 为空，因为整行代表 task） |
| GET | `/api/agents/:agentId/timeline` | **Agent 时间线**：某段时间内这个 agent 的工作状态与用户输入。`?from=&to=`（ISO，缺省最近 1 小时，跨度上限 30 天）、`?projectId=`。返回 `segments`（idle / thinking / working，首尾相接铺满窗口）或 `buckets`（跨度大时按时间桶聚合）+ `markers`（用户输入 / run 起止 / agent 替换 / 疑似停滞）+ `runs`（每轮 run 的 thinking·working 时长、工具·模型调用、触发输入）+ `totals`（活跃占比等）+ `note`（判定口径）+ `lastActiveAt`（这个 agent 自己的最近活跃时间，**不受查询窗口限制**：窗口里没有事件时前端靠它区分「窗口选错了」和「这个 agent 没动过」）+ `agentRunCount` / `agentCompletedRounds`（这个 agent 自己的累计，同样不限窗口：页面上的「run 轮次」只算窗口内） |
| GET | `/api/tasks/:id/events` | event timeline (`?after=<seq>`) |
| POST | `/api/tasks/:id/fork` | **上下文将满时的分流**：fork 成新 task（继承 project / provider / model / **同一个 workspace** / prUrl，记 `forkedFrom`），原 task 时间线留一条 `status: forked` 提示；历史不复制事件，改为在新 task 的启动简报里带一份（`carried`，带 `[fork:*]` 前缀） |
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
`npm ci` → typecheck → build → `npm test`. Compiled `backend/dist` and `web/dist`
are uploaded as GitHub Actions artifacts and expire after **7 days** (Actions run
→ Artifacts). This does not deploy: every deploy is triggered from the
independent deployment platform (`:4220`), which packages the merged `main`
commit and restarts the service. This repo has no deploy entry point.

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
web/src/          React UI (Chat / Timeline / UsageBar / TaskList + Projects)
  usage-cost.ts    成本两个口径的文案（计费表本币 vs SDK 上报美元，分开显示）
  timeline-line.ts  状态点线的几何（idle / thinking / working → 三条互不相连的水平线）
  board-format.ts   看板数字口径文案（per-agent vs 整个 task，两处都写清）
web/scripts/     前端纯逻辑测试（点线几何 + SVG 渲染，由 backend 的 run-tests 统一起跑）
workspace/        default sandbox for the local agent
```
