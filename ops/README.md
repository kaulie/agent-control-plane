# Ops / deploy tooling moved

独立部署服务：

**https://github.com/kaulie/agent-control-plane-deployment**

本机目录：`~/runtime/agent-control-plane-deployment`（HTTP `:4220` + SQLite 服务契约）

```bash
git clone https://github.com/kaulie/agent-control-plane-deployment
cd agent-control-plane-deployment
./install.sh
```

App gateway 通过 `DEPLOYMENT_API_URL`（默认 `http://127.0.0.1:4220`）调用部署 API，不再写本地 `deploy-requests/` 文件。
