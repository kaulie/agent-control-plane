# AGENTS.md — Web Cursor (mandatory)

You are the agent behind **Web Cursor**. These rules always apply.

## Per-task workspace (isolation)

| Path | Action |
|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | **Your sandbox** — cwd for this task; clone/work here（**开发 only**） |
| Project `gitRepoUrl` (GitHub) | **origin** for clone / push / PR；also the sole release source |
| [agent-control-plane-deployment](https://github.com/kaulie/agent-control-plane-deployment) | Independent deploy service (HTTP + SQLite contracts) |
| `~/runtime/agent-control-plane-deployment` | Deploy service install dir (`:4220`, packages, sqlite) — not the app |
| `~/runtime/web-cursor` | App runtime — **never** hand-edit; only the deployment platform ships into it |
| `/Users/gaolei/Projects/deepseek_web_cursor` | Optional local clone — **not** the deploy source |

**Branching (mandatory):** follow [`BRANCHING.md`](BRANCHING.md) — trunk-based, GitHub origin, deliver with `git push` + `gh pr create` (do not merge `main` or deploy unless the user asks).

**How to start work**

1. Your task workspace is already created (empty) under `agent-workspace/<taskId>/`.
2. Clone the project's **GitHub** `gitRepoUrl` into that directory, then create a task branch from latest `main` (e.g. `feature/<taskId>`). Develop only there — never on `main`.
3. Do **not** edit other tasks' directories. Do **not** edit runtime or `deployment-<hash>/` snapshots.

```bash
# from your task workspace cwd (use the project gitRepoUrl from bootstrap)
git clone <gitRepoUrl> .
git fetch origin && git checkout main && git pull --ff-only origin main
git checkout -b feature/<taskId>
# ... edit, commit ...
git push -u origin HEAD
gh pr create --base main --title "..." --body "..."
# write PR URL back to the task (or POST /api/tasks/<taskId>/pull-request)
```

## Deploys (never from this repo)

This repo has **no deploy entry point**: no deploy API, no release/deploy script.
Deploys are triggered **only** from the independent deployment platform:

- [agent-control-plane-deployment](https://github.com/kaulie/agent-control-plane-deployment) → `~/runtime/agent-control-plane-deployment` (HTTP `:4220`, Web UI + SQLite service contracts)
- the platform packs `main` (or a given ref) into `packages/deployment-<hash>/`, then rsyncs + restarts via the service contract (`startCmd` / `stopCmd` / `restartCmd` / `healthUrl`)
- trigger from the platform: its UI（流水线 / Deploys）, or `POST :4220/api/deploy-notify` (pack + deploy) / `POST :4220/api/deploys` (deploy an existing package)

What this app still exposes is only the **passive graceful-restart contract** that
the platform calls when it restarts this service:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/ops/restart-notify` | platform asks to drain: pause starting new runs, let in-flight runs finish |
| `GET` | `/api/ops/restart-status` | platform polls; `canRestart` / `ready` / `canDeploy` true → restart |

Rules:

- **Never** initiate a deploy from this repo or from an agent, and never run a deploy/restart script synchronously inside this agent process.
- Deployment is a **separate process** under `~/runtime/agent-control-plane-deployment`.
- Runtime does **not** `npm install` / `build`, and does **not** use git to change versions.
- A deploy's rsync **must** preserve `backend/.env` and `backend/data/`.
- Never hand-edit or ad-hoc copy into runtime.

**Self-restart note:** a platform deploy restarts the gateway (all tasks). Expect WS disconnect. Prefer finishing the reply before it happens, and tell the user the UI may briefly show “后端暂时不可达”.

## Ports

- Runtime listens on **4211** — do not steal this port for local/dev servers.
- Local/dev gateway: use another port (e.g. **4212**).

## Secrets / data

Never commit or overwrite `backend/.env` or `backend/data/`.

## Progress feedback (anti “stuck” UX)

Users often think a silent long tool call means the agent is dead. Prevent that:

1. **Never** chain typecheck + commit + deploy (or other multi-minute steps) in **one** shell command.
2. Split into short steps; after each step, **reply in chat** with the result (ok / fail / next).
3. Prefer commands that print progress (`echo` milestones). Avoid long silent waits without output.
4. While waiting on a platform deploy/restart, say explicitly: “正在同步/重启，大约需要几十秒，不是卡死”.
5. **Deploy last:** if the user asks you to ship, finish the user-visible reply **before** touching the deployment platform. If interrupted, **系统自检** will resume — give a clear 终态 reply there too.

See also: [`BRANCHING.md`](BRANCHING.md), `AGENT.md`, and `.cursor/rules/deploy-runtime.mdc`.
