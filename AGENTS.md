# AGENTS.md — Web Cursor (mandatory)

You are the agent behind **Web Cursor**. These rules always apply.

## Per-task workspace (isolation)

| Path | Action |
|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | **Your sandbox** — cwd for this task; clone/work here |
| Project `gitRepoUrl` (GitHub) | **origin** for clone / push / PR — do not invent another remote |
| `/Users/gaolei/Projects/deepseek_web_cursor` | Deploy worktree only (pull `main` after PR merge, then `deploy.sh`) — do not develop here |
| `/Users/gaolei/runtime/web-cursor` | **Never** edit source; production only |
| `/Users/gaolei/deployment/web-cursor/...` | Snapshots; do not hand-edit |

**Branching (mandatory):** follow [`BRANCHING.md`](BRANCHING.md) — trunk-based, GitHub origin, deliver with `git push` + `gh pr create` (do not merge `main` or deploy unless the user asks).

**How to start work**

1. Your task workspace is already created (empty) under `agent-workspace/<taskId>/`.
2. Clone the project's **GitHub** `gitRepoUrl` into that directory, then create a task branch from latest `main` (e.g. `feature/<taskId>`). Develop only there — never on `main`.
3. Do **not** edit other tasks' directories. Do **not** edit runtime. Do **not** edit the deploy worktree in place.

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

## Deploy only via script

After the GitHub PR is **merged** into `main`, update the local deploy worktree and run:

```bash
cd /Users/gaolei/Projects/deepseek_web_cursor
git fetch origin && git checkout main && git pull --ff-only origin main
./scripts/deploy.sh              # main latest
# or ./scripts/deploy.sh <hash>
```

`deploy.sh` does: `git fetch` + `reset --hard` on runtime → `npm run build` → restart → health check.

**Do not** patch runtime with editors, `cp`, `rsync`, or ad-hoc `npm run build` in runtime.

**Self-deploy note:** running `./scripts/deploy.sh` kills the gateway mid-run (all tasks). Expect WS disconnect + interrupted runs after restart. Prefer finishing the reply, then deploy in a short final step, and tell the user the UI may briefly show “后端暂时不可达”.

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
4. While waiting on deploy/build, say explicitly: “正在构建/重启，大约需要几十秒，不是卡死”.
5. **Deploy last:** finish the user-visible reply (what changed + outcome) **before** running `./scripts/deploy.sh`. If your run is interrupted for any reason, **系统自检** (generic delivery closure) will resume the unclosed user message — give a clear 终态 reply there too.

See also: [`BRANCHING.md`](BRANCHING.md) (trunk-based branching + GitHub PR), `AGENT.md` (full ops guide), and `.cursor/rules/deploy-runtime.mdc`.
