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

## Ports

- Runtime listens on **4211** — do not steal this port for local/dev servers.
- Local/dev gateway: use another port (e.g. **4212**).

## Secrets / data

Never commit or overwrite `backend/.env` or `backend/data/`.

See also: `AGENT.md` (full ops guide) and `.cursor/rules/deploy-runtime.mdc`.
