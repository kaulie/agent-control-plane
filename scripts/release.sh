#!/usr/bin/env bash
# 已废弃：本仓库不再提供发版入口。
# 构建 + 部署统一由部署平台完成（~/runtime/agent-control-plane-deployment，HTTP :4220）。
echo "[release] 已废弃：发版 / 部署统一走部署平台 ~/runtime/agent-control-plane-deployment（HTTP :4220）。" >&2
echo "[release] 触发方式：平台 UI「流水线」，或 POST http://127.0.0.1:4220/api/deploy-notify {serviceId,ref}。" >&2
exit 1
