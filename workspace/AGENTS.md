# AGENTS.md — sandbox fallback

If your cwd is this legacy `workspace/` folder, **do not** treat it as the app source tree.

1. Prefer the per-task sandbox: `/Users/gaolei/agent-workspace/<taskId>/` (clone/work there).
2. Never modify `/Users/gaolei/runtime/**`.
3. Deploy only from the canonical repo: `/Users/gaolei/Projects/deepseek_web_cursor` via `./scripts/deploy.sh`.

See repo-root `AGENTS.md` and `AGENT.md`.
