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
# open http://localhost:5174  (Vite proxies /api and /ws to the backend on :4211)
```

If you prefer to run the two halves in separate terminals:

```bash
npm run dev:backend   # backend :4211
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
| GET | `/api/projects` | list Projects |
| POST | `/api/projects` | create Project `{ name }` |
| PATCH | `/api/projects/:id` | rename Project `{ name }` |
| GET | `/api/tasks` | list Tasks (+ stats); optional `?projectId=` |
| POST | `/api/tasks` | create Task `{ title?, workspace?, model?, projectId? }` |
| GET | `/api/tasks/:id` | Task detail (task + runs + stats) |
| GET | `/api/tasks/:id/events` | event timeline (`?after=<seq>`) |
| POST | `/api/tasks/:id/messages` | send `{ message, mode?, images? }` → starts an Agent Run (`mode`: `agent` \| `plan`, default `agent`) |
| POST | `/api/tasks/:id/stop` | stop the in-flight Agent Run |
| GET | `/api/stats/token-usage` | 按 provider/model 粒度、按时间统计总 token 消耗量（`?granularity=hour\|day\|week&projectId=&from=&to=`；缺省按天） |
| WS | `/ws` | real-time push: `agent_event`, `task_updated`, `task_created`, `project_created`, `project_updated` |

Each Task belongs to a Project (`projectId`). On first boot a default project
`Default` (`project-default`) is created and existing tasks are attached to it.

## CI

Pull requests and pushes to `main` run [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
`npm ci` → typecheck → build → `npm test`. Compiled `backend/dist` and `web/dist`
are uploaded as GitHub Actions artifacts and expire after **7 days** (Actions run
→ Artifacts). This does not deploy; production still uses `release.sh` then
async `POST /api/ops/deploy`.

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
