# Agent 开发规范（Web Cursor）

本文是 agent 在本仓库开发时必须遵守的约定。

## 三个目录的职责

| 目录 | 含义 | 谁改 |
|---|---|---|
| `/Users/gaolei/Projects/deepseek_web_cursor` | 开发目录（git 仓库） | agent 在这里改代码 |
| `/Users/gaolei/deployment/web-cursor/deployment-XXX` | 待上线版本（版本化，XXX 递增） | 每次上线前生成，一般不改 |
| `/Users/gaolei/runtime/web-cursor` | 线上当前运行目录 | 只保留运行相关内容，**不要直接改** |

## 端口规范（重要）

- **线上（runtime）端口固定为 `4211`**，开发阶段必须避开，改用其它端口（例如 `4212`）。
- 切换开发端口需要**同时改两处**：
  1. `backend/.env` → `PORT=4212`
  2. `web/vite.config.ts` → 代理目标改成 `http://127.0.0.1:4212` 与 `ws://127.0.0.1:4212`
- 永远不要占用 `4211`，避免与线上冲突。

## 版本管理

- 改动后提交 git：`git add -A && git commit -m "描述"`。
- 每次「待上线」对应一个递增的 deployment 版本：
  - 在 dev 打 tag：`git tag deployment-XXX`
  - 生成目录快照：`deployment/web-cursor/deployment-XXX/`
- 上线 = 把某个 deployment-XXX 部署到 `runtime/web-cursor` 并重启。

## 安全

- **不要提交** `backend/.env`（含 API key）与 `backend/data/`（本地数据库），两者已在 `.gitignore` 中。
- `CURSOR_API_KEY` 是敏感信息：不要打印、不要写进日志、不要提交。

## 目录结构

- `backend/` —— Agent Gateway（Fastify + `@cursor/sdk` + `node:sqlite`）
- `web/` —— 前端（React + Vite）
- `workspace/` —— agent 默认工作沙盒

## 开发与上线流程

1. 在**开发目录**改代码、本地自测（避开 4211）。
2. `git add -A && git commit -m "..."` 提交。
3. 生成 deployment-XXX（tag + 目录快照）。
4. 将 deployment-XXX 部署到 `runtime/web-cursor` 并重启，完成上线。

