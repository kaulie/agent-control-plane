# Agent 开发规范（Web Cursor）

本文是 agent 在本仓库开发时必须遵守的约定。

## 目录职责

| 目录 | 含义 | 谁改 |
|---|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | 本 task 独立 workspace（clone GitHub + task 分支） | agent 在此改**应用**代码 |
| 项目 `gitRepoUrl`（GitHub） | 开发远程 origin（clone / push / PR）；发版唯一源 | 在项目设置中配置；agent 不改配置本身 |
| `/Users/gaolei/deployment/web-cursor/bin/` | 独立发版工具（`release.sh` / `deploy.sh`） | 与 app 解耦；仅在用户要求改发版流程时改 |
| `/Users/gaolei/deployment/web-cursor/deployment-<hash>/` | **待上线精确包**（release 时已 build；禁止手改） | 仅 `bin/release.sh` 生成 |
| `/Users/gaolei/runtime/web-cursor` | 固定线上运行目录 | 仅 `bin/deploy.sh` rsync 代码；保留 `.env`/`data` |
| `/Users/gaolei/Projects/deepseek_web_cursor` | 可选本机 clone（**不是**部署源） | 不要在此直接开发 |

Gateway 默认把本地 agent 的 `cwd` 设为 task workspace，并启用 `settingSources: ["project"]`，以加载本仓库的 `AGENTS.md` / `.cursor/rules`。  
约束摘要见根目录 [`AGENTS.md`](AGENTS.md)、[`BRANCHING.md`](BRANCHING.md)，以及 [`.cursor/rules/deploy-runtime.mdc`](.cursor/rules/deploy-runtime.mdc)。

## 端口规范（重要）

- **线上（runtime）端口固定为 `4211`**，开发阶段必须避开，改用其它端口（例如 `4212`）。
- 切换开发端口需要**同时改两处**：
  1. `backend/.env` → `PORT=4212`
  2. `web/vite.config.ts` → 代理目标改成 `http://127.0.0.1:4212` 与 `ws://127.0.0.1:4212`
- 永远不要占用 `4211`，避免与线上冲突。

## 版本与发版

- 开发：在 task 分支 commit / push / GitHub PR（仅在 workspace）。
- 发版包：`/Users/gaolei/deployment/web-cursor/bin/release.sh [ref]` → 从 GitHub 取精确 commit，生成 `deployment-<hash>/`，并在**该目录内** `npm install` + `npm run build`。
- 上线：`/Users/gaolei/deployment/web-cursor/bin/deploy.sh deployment-<hash>` → rsync 到 runtime（排除 `.env`/`data` 等）→ 重启。
- runtime **不再**现场构建，也 **不再**用 `git reset` 换版。
- **不要**在 `agent-workspace/**` 执行发版；不需要常驻 app clone / `repo` 目录来发版。

## 部署动作约束（重要）

**上线一律：`bin/release.sh` → `bin/deploy.sh deployment-<hash>`**，不要手工操作。

1. **禁止**对 runtime 手改文件或 ad-hoc `cp`/`rsync`；代码同步只允许 `bin/deploy.sh`。
2. **禁止**覆盖 runtime 的 `backend/.env`、`backend/data/`。
3. **禁止**手改 `deployment-<hash>/` 快照。
4. 部署顺序：校验快照已构建 → rsync → restart → `curl /health` 必须 200。
5. 重启必须确认新进程存活；禁止只 kill 不启动。

## 运维脚本

### 上线域（独立于 app 仓库）

路径：`/Users/gaolei/deployment/web-cursor/bin/`

| 脚本 | 用法 | 作用 |
|---|---|---|
| `release.sh` | `bin/release.sh [ref]` | 从 GitHub 冻结 `deployment-<hash>` 并在快照内构建 |
| `deploy.sh` | `bin/deploy.sh deployment-<hash>` | rsync 快照 → runtime，然后重启（不构建） |

环境变量：`GIT_REPO_URL`（默认项目 GitHub）、`DEPLOYMENT_ROOT`、`RUNTIME_DIR`、`PORT`、`APP_VERSION`。

### 运行时启停（随发版包进入 runtime）

仓库 `scripts/start.sh` / `stop.sh` / `restart.sh` / `watchdog.sh` 属于**应用运行时**配套，会随 `deployment-<hash>` rsync 到 runtime；由 `bin/deploy.sh` 调用 runtime 内的 `scripts/restart.sh`。

仓库根目录若仍保留 `scripts/release.sh` / `scripts/deploy.sh`，仅为兼容提示（转发或指引到 `bin/`），**不以 workspace 内执行为准**。

## 安全

- **不要提交** `backend/.env`（含 API key）与 `backend/data/`（本地数据库），两者已在 `.gitignore` 中。
- `CURSOR_API_KEY` 是敏感信息：不要打印、不要写进日志、不要提交。

## 目录结构

- `backend/` —— Agent Gateway（Fastify + `@cursor/sdk` + `node:sqlite`）
- `web/` —— 前端（React + Vite）
- `workspace/` —— 旧版相对沙盒（遗留；新 task 默认用 `/Users/gaolei/agent-workspace/<taskId>/`）
- `scripts/` —— 运行时启停等（`start` / `stop` / `restart` / `watchdog`）；发版入口在 `deployment/.../bin/`

## 开发与上线流程

1. 在 **task workspace** 改代码、本地自测（避开 4211）。
2. `git commit` → `git push` → `gh pr create`，回写 `prUrl`。
3. PR 合入 GitHub `main` 后（用户要求上线时）：
   `bin/release.sh` → `bin/deploy.sh deployment-<hash>`。
4. 确认 `curl http://127.0.0.1:4211/health` 的 `version` 为该 hash。
