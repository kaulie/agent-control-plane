# AGENTS.md — sandbox fallback

If your cwd is this legacy `workspace/` folder, **do not** treat it as the app source tree.

1. Prefer the per-task sandbox: `/Users/gaolei/agent-workspace/<taskId>/` (clone/work there).
2. Never modify `/Users/gaolei/runtime/**`.
3. Deploys are **platform-side only** (`~/runtime/agent-control-plane-deployment`, `:4220`) — never ship from this folder or `Projects/`.

See repo-root `AGENTS.md` and `AGENT.md`.
