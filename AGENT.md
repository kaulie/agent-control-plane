# Agent 开发规范（Web Cursor）

本文是 agent 在本仓库开发时必须遵守的约定。

## 目录职责

| 目录 | 含义 | 谁改 |
|---|---|---|
| `/Users/gaolei/agent-workspace/agent-<agentid>/` | 本 agent 独立 workspace（clone GitHub + task 分支）；`agentid` = 这个 agent 的 id，目录名就是它 | agent 在此改**应用**代码 |
| 项目仓库地址 | 应用里**没有**这个字段（老的 `gitRepoUrl` 已删：接口不返回、UI 不展示）；注入 agent 的仓库地址来自**服务中心**（project → 组织 → `GET /v1/orgs/{orgId}/services`） | 不需要配置；agent 不改配置本身 |
| `/Users/gaolei/deployment/web-cursor/bin/` | 旧版独立发版工具（**已废弃**，构建/部署现由部署平台 pipeline 完成） | 不要使用 |
| `~/runtime/agent-control-plane-deployment/packages/` | 部署平台构建出的 `deployment-<hash>/` 快照（禁止手改） | 平台自己生成 |
| `/Users/gaolei/runtime/web-cursor` | 固定线上运行目录 | 仅由部署平台 rsync 代码；保留 `.env`/`data` |
| `/Users/gaolei/Projects/deepseek_web_cursor` | 可选本机 clone（**不是**部署源） | 不要在此直接开发 |

Gateway 默认把本地 agent 的 `cwd` 设为 task workspace，并启用 `settingSources: ["project"]`，以加载本仓库的 `AGENTS.md` / `.cursor/rules`。  
约束摘要见根目录 [`AGENTS.md`](AGENTS.md)、[`BRANCHING.md`](BRANCHING.md)，以及 [`.cursor/rules/deploy-runtime.mdc`](.cursor/rules/deploy-runtime.mdc)。

## 端口规范（重要）

- 启动端口按 **`SERVICE_PORT` → `PORT`（旧用法）→ `4211`（默认）** 解析；两者都读不到/非法时回退默认。
  - 后端：`backend/src/config.ts` 的 `resolvePort()`（`SERVICE_PORT` 优先，`PORT` 兼容保留）。
  - 脚本：`scripts/start.sh` / `stop.sh` / `watchdog.sh` 用同一套解析，`start.sh` 会把端口导出给 node，
    保证「监听端口」与「健康检查 / 端口清理」始终一致。
  - 开发代理：`web/vite.config.ts` 也按同一优先级取后端端口，改端口不再需要手改代理目标。
- **线上（runtime）默认端口为 `4211`**，开发阶段必须避开，改用其它端口（例如 `SERVICE_PORT=4212` 或 `PORT=4212`）。
- 切换开发端口（二选一即可，代理会自动跟随）：
  1. `backend/.env` → `SERVICE_PORT=4212`（或 `PORT=4212`）
  2. 或直接 `SERVICE_PORT=4212 bash scripts/start.sh`
- 永远不要占用 `4211`，避免与线上冲突。

## 外部服务依赖

- 项目「所属部门」的可选值来自 **organization 服务**（源码 [organization](https://github.com/kaulie/organization)，本机 `~/runtime/organization`，`:4244`）：
  `GET /api/v1/departments` → `{ items: [{ id, name, type }], types }`。
- 网关只做**只读代理 + 短缓存**：`GET /api/org/departments`（`backend/src/organization.ts`，成功缓存 30s、失败缓存 5s，`?refresh=1` 强制刷新）。
  该服务不可达时返回 `available:false`（HTTP 200），项目设置页保留已存值并提示「组织服务不可达」，不会阻塞设置页加载。
- 配置：`ORGANIZATION_API_URL`（默认 `http://127.0.0.1:4244`）、`ORGANIZATION_TIMEOUT_MS`（默认 3000ms）。
- 存储：项目设置 `department: { departmentId, departmentName }` 落在 `projects.settings_json`；
  只存 ID + 名称快照，不校验 ID 是否仍存在（部门被改名/删除时保留旧值并标注）。

## 写操作必须校验页面版本（重要）

前端发起的所有写操作，都必须证明「发起写的页面版本」与「项目当前版本」一致，否则拒绝落地。

- 前端：`web/src/api.ts` 里所有写（POST/PATCH/PUT/DELETE）统一走 `write()` —— 提交前先 `GET /health`
  比对 `APP_VERSION`，并带上 `x-ui-version` 头；不一致时**不发请求**，直接抛 `StaleUiVersionError`。
- 网关：`backend/src/http/ui-version.ts` 用 `onRequest` 钩子校验**所有** `/api/*` 写请求的
  `x-ui-version`（与磁盘 `VERSION` = `/health` 的 `version` 比对）：缺失 → `428`，不一致 → `409`；
  body 为 `{ code: "ui-version-mismatch", clientVersion, serverVersion, mustRefresh: true, error }`；
  钩子在 handler 之前执行，被拒绝的写**不会生效**。
- 例外（不校验）：非写方法、非 `/api/` 路径、`/api/ops/*`（部署平台的 graceful 契约，不是浏览器发的）。
- 前端拿到拒绝（预检或网关）后弹「页面版本已过期，本次提交被拒绝」，主按钮「立即刷新」（`beginUpgrade`）。
- 新增写接口无需额外配置（钩子按「方法 + 路径前缀」自动覆盖），但**不要**绕过 `api.ts` 的 `write()` 直接 `fetch`。
- 自测：`node backend/scripts/test-ui-version-guard.mjs`（已加入 `npm test`）。

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

登记到部署服务由**部署平台侧统一管控**（app 不再调用 `:4220/api/services/:id`，不再提供 `GET /api/ops/deployment-services`，项目设置里也不再保存 service 列表）。需要手工登记时：

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
- `workspace/` —— 旧版相对沙盒（遗留；新 task 默认用 `/Users/gaolei/agent-workspace/agent-<agentid>/`）
- `scripts/` —— 运行时启停等（`start` / `stop` / `restart` / `watchdog`）；发版 / 部署在部署平台，不在本仓库

## 开发与上线流程

1. 在 **task workspace** 改代码、本地自测（避开 4211）。
2. `git commit` → `git push` → `gh pr create`，回写 `prUrl`。
3. PR 合入 GitHub `main` 后（用户要求上线时）：由**部署平台**打包并部署（UI 流水线，或 `POST :4220/api/deploy-notify`）。
4. 确认 `curl http://127.0.0.1:4211/health` 的 `version` 为该 hash。
