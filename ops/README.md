# Ops / deploy tooling moved

独立部署与运维脚本已迁到：

**https://github.com/kaulie/agent-control-plane-deployment**

本机安装：

```bash
git clone https://github.com/kaulie/agent-control-plane-deployment
cd agent-control-plane-deployment
DEPLOY_HOME=/Users/gaolei/deployment/web-cursor ./install.sh
```

发版 / 上线请使用：

- `/Users/gaolei/deployment/web-cursor/bin/release.sh`
- `/Users/gaolei/deployment/web-cursor/bin/deploy.sh`
- 或 gateway `POST /api/ops/deploy`（异步，推荐）

应用仓库只保留 gateway 侧的 deploy API（graceful restart 等），不再携带 ops 守护进程源码。
