#!/usr/bin/env bash
echo "[deploy] 请改用部署服务 HTTP API: POST http://127.0.0.1:4220/api/deploys" >&2
echo "[deploy] 或: ~/runtime/agent-control-plane-deployment/bin/deploy.sh <serviceId> deployment-<hash>" >&2
API="${DEPLOYMENT_API_URL:-http://127.0.0.1:4220}"
SERVICE_ID="${1:-web-cursor}"
DEPLOYMENT="${2:-}"
if [ -z "${DEPLOYMENT}" ]; then
  echo "用法: $0 <serviceId> deployment-<hash>" >&2
  exit 1
fi
exec curl -sS -X POST "${API}/api/deploys" \
  -H 'content-type: application/json' \
  -d "{\"serviceId\":\"${SERVICE_ID}\",\"deployment\":\"${DEPLOYMENT}\"}"
