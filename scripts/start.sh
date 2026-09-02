#!/usr/bin/env bash
# 启动 runtime 进程（不构建；构建请用 deploy.sh）。
set -euo pipefail

RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
BACKEND_DIR="${RUNTIME_DIR}/backend"
PID_FILE="${BACKEND_DIR}/runtime.pid"
LOG_FILE="${BACKEND_DIR}/server.log"
PORT="${PORT:-4211}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
PAUSED_FLAG="${BACKEND_DIR}/.watchdog-paused"

# 用户显式启动 → 清除看门狗暂停标记
rm -f "${PAUSED_FLAG}"

# 已在运行则跳过
if [ -n "$(lsof -ti:${PORT} 2>/dev/null || true)" ]; then
  echo "[start] 已在运行（端口 ${PORT} 被占用），跳过"
  exit 0
fi

# 必须先构建
[ -f "${BACKEND_DIR}/dist/index.js" ] || {
  echo "[start][错误] 未找到 ${BACKEND_DIR}/dist/index.js，请先运行 ./scripts/deploy.sh 构建" >&2
  exit 1
}

mkdir -p "${BACKEND_DIR}"

# 与 deploy 一致：用 runtime git HEAD 作为运行版本（restart 不经 deploy 时也正确）
if [ -d "${RUNTIME_DIR}/.git" ]; then
  export APP_VERSION="$(git -C "${RUNTIME_DIR}" rev-parse --short=8 HEAD 2>/dev/null || echo dev)"
else
  export APP_VERSION="${APP_VERSION:-dev}"
fi

cd "${BACKEND_DIR}"
nohup env APP_VERSION="${APP_VERSION}" node dist/index.js > "${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" > "${PID_FILE}"
echo "[start] 新进程 PID=${NEW_PID}"

for _ in $(seq 1 30); do
  if curl -s -m 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[start] 启动成功: ${HEALTH_URL}"
    exit 0
  fi
  sleep 1
done
echo "[start][错误] 健康检查未通过（30 秒超时），最近日志：" >&2
tail -20 "${LOG_FILE}" >&2
exit 1
