# AGENTS.md — sandbox fallback

If your cwd is this `workspace/` folder, **do not** treat it as the app source tree.

1. Edit application code only under `/Users/gaolei/Projects/deepseek_web_cursor`.
2. Never modify `/Users/gaolei/runtime/**`.
3. Deploy only from the **dev** repo: `./scripts/deploy.sh`.

Preferred setup: gateway `AGENT_WORKSPACE` should point at the **dev** repo so project rules load from there. See repo-root `AGENTS.md` and `AGENT.md`.
