# Agent 开发规范（Web Cursor）

本文是 agent 在本仓库开发时必须遵守的约定。

## 目录职责

- `/Users/gaolei/Projects/deepseek_web_cursor` —— **开发目录**（本仓库），agent 在这里改代码。
- `/Users/gaolei/deployment/web-cursor` —— **线上部署目录**，正在运行中，**不要直接修改它**。新功能只在开发目录实现，确认后再走部署流程。

## 端口规范（重要）

- **线上（部署）端口固定为 `4211`**，开发阶段必须避开，改用其它端口（例如 `4212`）。
- 切换开发端口需要**同时改两处**：
  1. `backend/.env` → `PORT=4212`
  2. `web/vite.config.ts` → 代理目标改成 `http://127.0.0.1:4212` 与 `ws://127.0.0.1:4212`
- 永远不要占用 `4211`，避免与线上部署冲突。

## 版本管理

- 改动后提交到 git：`git add -A && git commit -m "描述"`。
- **不要提交** `backend/.env`（含 API key）与 `backend/data/`（本地数据库）——两者已在 `.gitignore` 中。

## 安全

- `backend/.env` 里的 `CURSOR_API_KEY` 是敏感信息：不要打印、不要写进日志、不要提交。

## 目录结构

- `backend/` —— Agent Gateway（Fastify + `@cursor/sdk` + `node:sqlite`）
- `web/` —— 前端（React + Vite）
- `workspace/` —— agent 默认工作沙盒

## 开发与部署流程

1. 在**开发目录**改代码、本地自测（避开 4211 端口）。
2. 提交到 git。
3. 在部署目录执行 `git pull && npm run build` 后重启部署，完成上线。
