# AGENTS.md — Web Cursor (mandatory)

You are the agent behind **Web Cursor**. These rules always apply.

## Per-task workspace (isolation)

| Path | Action |
|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | **Your sandbox** — cwd for this task; clone/work here（**开发 only**） |
| Project `gitRepoUrl` (GitHub) | **origin** for clone / push / PR；also the sole release source |
| `/Users/gaolei/deployment/web-cursor/bin/` | Independent ship tools (`release.sh` / `deploy.sh`) — not part of the app |
| `/Users/gaolei/deployment/web-cursor/deployment-<hash>/` | Frozen release package (built at release time) — never hand-edit |
| `/Users/gaolei/runtime/web-cursor` | Fixed production dir — **never** edit; only `bin/deploy.sh` may rsync code in |
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

## Deploy only via independent bin scripts

After the GitHub PR is **merged** into `main` (and the user asks to ship):

```bash
/Users/gaolei/deployment/web-cursor/bin/release.sh
# freeze + build deployment-<hash>/ from GitHub (default: main)

/Users/gaolei/deployment/web-cursor/bin/deploy.sh deployment-<hash>
# rsync package → runtime, then restart
```

- `release.sh` / `deploy.sh` are **ops tools**, independent of the app and of task workspaces.
- **Never** run release/deploy from `agent-workspace/**`; do not rely on a long-lived app checkout to ship.
- Build happens **only** inside `deployment-<hash>/`.
- Runtime does **not** `npm install` / `build`, and does **not** use git to change versions.
- `deploy.sh` rsync **must** preserve `backend/.env` and `backend/data/`.
- Never hand-edit or ad-hoc copy into runtime.

**Self-deploy note:** `deploy.sh` restarts the gateway (all tasks). Expect WS disconnect. Prefer finishing the reply, then deploy, and tell the user the UI may briefly show “后端暂时不可达”.

## Ports

- Runtime listens on **4211** — do not steal this port for local/dev servers.
- Local/dev gateway: use another port (e.g. **4212**).

## Secrets / data

Never commit or overwrite `backend/.env` or `backend/data/`.

## Progress feedback (anti “stuck” UX)

Users often think a silent long tool call means the agent is dead. Prevent that:

1. **Never** chain typecheck + commit + release/deploy (or other multi-minute steps) in **one** shell command.
2. Split into short steps; after each step, **reply in chat** with the result (ok / fail / next).
3. Prefer commands that print progress (`echo` milestones). Avoid long silent waits without output.
4. While waiting on release/deploy, say explicitly: “正在构建/同步/重启，大约需要几十秒，不是卡死”.
5. **Deploy last:** finish the user-visible reply **before** running release/deploy. If interrupted, **系统自检** will resume — give a clear 终态 reply there too.

See also: [`BRANCHING.md`](BRANCHING.md), `AGENT.md`, and `.cursor/rules/deploy-runtime.mdc`.
