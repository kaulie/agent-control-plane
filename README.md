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
   can list only the current agent per task or every agent (including the ones
   replaced by a succession), and clicking a task cell jumps to that task.

> The agent runs in the `workspace/` directory by default (set `AGENT_WORKSPACE`
> in `backend/.env` to change it). Each run is billed to the authenticated
> Cursor account.

## Cost

Cost is computed in `backend/src/usage/` (kept out of the UI):

- If the SDK returns a server-derived billed cost, it is used.
- Otherwise (local agents are often plan-included, so `getUsage()` returns
  nothing billable), an estimate is produced from the per-model pricing table
  in `backend/src/usage/pricing.ts`.

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
| GET | `/api/agents` | **Agent 看板**：列出每个 agent（`?scope=current\|all`，默认只列当前 agent；`?projectId=` 过滤），带 `agentName`（由 agent id 归一化，独立于 task 标题）/ 所在部门（task 所属 project 的部门）/ project / task 标题 / `completedRounds`（累计完成对话轮次 = finished 的 run 数）/ 最后活跃时间 / 模型 / token 消耗 / 累计工作时长 |
| GET | `/api/tasks/:id/events` | event timeline (`?after=<seq>`) |
| POST | `/api/tasks/:id/messages` | send `{ message, mode?, images? }` → starts an Agent Run (`mode`: `agent` \| `plan`, default `agent`) |
| POST | `/api/tasks/:id/stop` | stop the in-flight Agent Run |
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
  usage/          pricing + CostCalculator
  http/ ws/       REST + WebSocket
web/src/          React UI (Chat / Timeline / UsageBar / TaskList + Projects)
workspace/        default sandbox for the local agent
```
