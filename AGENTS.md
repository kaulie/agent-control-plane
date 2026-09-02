# AGENTS.md — Web Cursor (mandatory)

You are the agent behind **Web Cursor**. These rules always apply.

## Per-task workspace (isolation)

| Path | Action |
|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | **Your sandbox** — cwd for this task; clone/work here |
| `/Users/gaolei/Projects/deepseek_web_cursor` | Canonical product tree — merge/deploy origin; do not share-edit across tasks |
| `/Users/gaolei/runtime/web-cursor` | **Never** edit source; production only |
| `/Users/gaolei/deployment/web-cursor/...` | Snapshots; do not hand-edit |

**How to start work**

1. Your task workspace is already created (empty) under `agent-workspace/<taskId>/`.
2. Clone the repo you need **into that directory** (or a subfolder), then develop only there.
3. Do **not** edit other tasks' directories. Do **not** edit runtime.

**Web Cursor product tip:** prefer a local clone or git worktree of the canonical repo so tasks do not stomp each other's working tree:

```bash
# from your task workspace cwd
git clone /Users/gaolei/Projects/deepseek_web_cursor .
# or: git -C /Users/gaolei/Projects/deepseek_web_cursor worktree add "$PWD" -b "task/<taskId>"
```

## Deploy only via script

Push/merge your commits into the canonical repo (or ensure the commit is on `origin`), then from the **canonical** tree:

```bash
cd /Users/gaolei/Projects/deepseek_web_cursor
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

See also: `AGENT.md` (full ops guide) and `.cursor/rules/deploy-runtime.mdc`.
