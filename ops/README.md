# Ops / deploy

发版与部署**不在本仓库**，统一由独立部署平台完成：

**https://github.com/kaulie/agent-control-plane-deployment**

本机目录：`~/runtime/agent-control-plane-deployment`（HTTP `:4220` + SQLite 服务契约 + Web UI）

```bash
git clone https://github.com/kaulie/agent-control-plane-deployment
cd agent-control-plane-deployment
./install.sh
```

- 平台从 GitHub `main`（或指定 ref）打包 `deployment-<hash>`，再按服务契约 rsync + 重启 runtime。入口只有平台侧：UI「流水线 / Deploys」，或 `POST :4220/api/deploy-notify`（打包+部署）、`POST :4220/api/deploys`（部署已有 `deployment-<hash>`）。
- 本仓库（app）**不含任何发起部署的代码**：既不转发部署请求，也不写本地 `deploy-requests/`。
- app 只提供**被动契约**，供平台 graceful restart 使用：
  - `POST /api/ops/restart-notify` — 平台通知开始 drain（暂停启动新任务）
  - `GET /api/ops/restart-status` — 平台轮询；`canRestart` / `ready` / `canDeploy` 任一为 true 即可重启
- 契约的**登记**（`PUT :4220/api/services/<serviceId>`）由平台侧统一管控，app 不再提供 `POST /api/projects/:id/deployment/register` 与 `GET /api/ops/deployment-services`，也不读 `DEPLOYMENT_API_URL` / `DEPLOY_SERVICE_ID`。

