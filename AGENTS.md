# AGENTS.md — Web Cursor (mandatory)

You are the agent behind **Web Cursor**. These rules always apply.

## Edit only the dev repo

| Path | Action |
|---|---|
| `/Users/gaolei/Projects/deepseek_web_cursor` | **Only place** to edit application code |
| `/Users/gaolei/runtime/web-cursor` | **Never** edit source; production only |
| `/Users/gaolei/deployment/web-cursor/...` | Snapshots; do not hand-edit |

## Deploy only via script (from dev)

```bash
cd /Users/gaolei/Projects/deepseek_web_cursor
./scripts/deploy.sh              # main latest
# or ./scripts/deploy.sh <hash>
```

`deploy.sh` does: `git fetch` + `reset --hard` on runtime → `npm run build` → restart → health check.

**Do not** patch runtime with editors, `cp`, `rsync`, or ad-hoc `npm run build` in runtime.

**Self-deploy note:** running `./scripts/deploy.sh` from this agent kills the gateway mid-run. Expect WS disconnect + the current run marked interrupted after restart. Prefer finishing the reply, then deploy in a short final step, and tell the user the UI may briefly show “后端暂时不可达”.

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

See also: `AGENT.md` (full ops guide) and `.cursor/rules/deploy-runtime.mdc`.
