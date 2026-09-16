# Agent 开发规范（Web Cursor）

本文是 agent 在本仓库开发时必须遵守的约定。

## 目录职责

| 目录 | 含义 | 谁改 |
|---|---|---|
| `/Users/gaolei/agent-workspace/<taskId>/` | 本 task 独立 workspace（clone GitHub + task 分支） | agent 在此改**应用**代码 |
| 项目 `gitRepoUrl`（GitHub） | 开发远程 origin（clone / push / PR）；发版唯一源 | 在项目设置中配置；agent 不改配置本身 |
| `/Users/gaolei/deployment/web-cursor/bin/` | 旧版独立发版工具（**已废弃**，构建/部署现由部署平台 pipeline 完成） | 不要使用 |
| `~/runtime/agent-control-plane-deployment/packages/` | 部署平台构建出的 `deployment-<hash>/` 快照（禁止手改） | 平台自己生成 |
| `/Users/gaolei/runtime/web-cursor` | 固定线上运行目录 | 仅由部署平台 rsync 代码；保留 `.env`/`data` |
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
- 构建 + 部署：**全部由部署平台完成**（源码 [`agent-control-plane-deployment`](https://github.com/kaulie/agent-control-plane-deployment)，本机 `~/runtime/agent-control-plane-deployment`，`:4220`）。平台从 GitHub ref 打包 `deployment-<hash>/`，再按服务契约 rsync + 重启。
- **本仓库不存在发版 / 部署入口**：没有部署 API、没有 release/deploy 脚本；不要在 app 内、也不要在 `agent-workspace/**` 里触发部署。
- runtime **不再**现场构建，也 **不再**用 `git reset` 换版。

## 部署动作约束（重要）

**部署统一由部署平台发起（UI 或 `POST :4220/api/deploy-notify` / `POST :4220/api/deploys`）；本仓库只被动配合。**

1. **禁止**在本仓库或 agent 进程内发起部署，也**禁止**同步执行任何 deploy/restart 脚本（会杀掉正在跑命令的自己）。
2. **禁止**对 runtime 手改文件或 ad-hoc `cp`/`rsync`；代码同步只允许平台按服务契约执行。
3. **禁止**覆盖 runtime 的 `backend/.env`、`backend/data/`。
4. **禁止**手改平台生成的 `deployment-<hash>/` 快照。
5. 部署后核对 `curl http://127.0.0.1:4211/health` 的 `version` 是否为该 hash。
6. 探活与换版均由**部署平台**完成（`~/runtime/agent-control-plane-deployment`），不依赖 runtime 内常驻脚本。

## 运维脚本

### 上线域（独立于 app 仓库）

路径：源码 [`agent-control-plane-deployment`](https://github.com/kaulie/agent-control-plane-deployment)；本机 `~/runtime/agent-control-plane-deployment`（HTTP `:4220`）。

| 入口 | 用法 | 作用 |
|---|---|---|
| 平台 UI（流水线） | 选服务 + ref | 从 GitHub 打包 `deployment-<hash>/` 并部署 |
| `POST :4220/api/deploy-notify` | `{ serviceId, ref? }` | 同上（打包 + 部署） |
| `POST :4220/api/deploys` | `{ serviceId, deployment }` | 部署已有 `deployment-<hash>` |
| `PUT :4220/api/services/:id` | 契约字段 | 注册/更新启停与 health |
| `./install.sh` | 安装到 runtime 目录并启动部署服务 | |

App 侧**没有部署入口**，只提供平台回调的 graceful 契约。

环境变量（app）：`GRACEFUL_RESTART`、`DEPLOY_GRACEFUL_WAIT_MS`。

**项目方 graceful 契约（部署服务回调）：**

| Method | URL（本仓库默认） | 作用 |
|---|---|---|
| `POST` | `http://127.0.0.1:4211/api/ops/restart-notify` | 开始 drain（`admissionPaused`） |
| `GET` | `http://127.0.0.1:4211/api/ops/restart-status` | 轮询；`canRestart`/`canDeploy`/`ready` 任一为 true 即可重启 |

登记到部署服务由**部署平台侧统一管控**（app 不再调用 `:4220/api/services/:id`，也不再提供 `GET /api/ops/deployment-services`）。需要手工登记时：

```bash
curl -sS -X PUT http://127.0.0.1:4220/api/services/web-cursor \
  -H 'content-type: application/json' \
  -d '{"restartNotifyUrl":"http://127.0.0.1:4211/api/ops/restart-notify","restartPollUrl":"http://127.0.0.1:4211/api/ops/restart-status","gracefulRestartMaxWaitMs":300000}'
```

### 运行时启停（随发版包进入 runtime）

仓库 `scripts/start.sh` / `stop.sh` / `restart.sh` / `watchdog.sh` 属于**应用运行时**配套，会随 `deployment-<hash>` rsync 到 runtime；部署平台按服务契约（`startCmd` / `stopCmd` / `restartCmd`）调用它们。

仓库根目录的 `scripts/release.sh` 仅为历史提示（指向已废弃的本机发版工具）；`scripts/deploy.sh` 已删除。发版 / 部署入口只存在于部署平台。

## 安全

- **不要提交** `backend/.env`（含 API key）与 `backend/data/`（本地数据库），两者已在 `.gitignore` 中。
- `CURSOR_API_KEY` 是敏感信息：不要打印、不要写进日志、不要提交。

## 目录结构

- `backend/` —— Agent Gateway（Fastify + `@cursor/sdk` + `node:sqlite`）
- `web/` —— 前端（React + Vite）
- `workspace/` —— 旧版相对沙盒（遗留；新 task 默认用 `/Users/gaolei/agent-workspace/<taskId>/`）
- `scripts/` —— 运行时启停等（`start` / `stop` / `restart` / `watchdog`）；发版 / 部署在部署平台，不在本仓库

## 开发与上线流程

1. 在 **task workspace** 改代码、本地自测（避开 4211）。
2. `git commit` → `git push` → `gh pr create`，回写 `prUrl`。
3. PR 合入 GitHub `main` 后（用户要求上线时）：由**部署平台**打包并部署（UI 流水线，或 `POST :4220/api/deploy-notify`）。
4. 确认 `curl http://127.0.0.1:4211/health` 的 `version` 为该 hash。
