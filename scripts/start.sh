#!/usr/bin/env bash
# 启动 runtime 进程（不构建；换版请用 release.sh + deploy.sh）。
# 日志追加 + 轮转；node 退出码/信号由 supervise-node.sh 记录；开启 Node fatal report。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
BACKEND_DIR="${RUNTIME_DIR}/backend"
PID_FILE="${BACKEND_DIR}/runtime.pid"
SUPERVISOR_PID_FILE="${BACKEND_DIR}/runtime.supervisor.pid"
EXIT_STATUS_FILE="${BACKEND_DIR}/node-exit.status"
REPORT_DIR="${BACKEND_DIR}/reports"
LOG_FILE="${BACKEND_DIR}/server.log"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-10485760}"   # 10 MiB
LOG_BACKUPS="${LOG_BACKUPS:-5}"
PORT="${PORT:-4211}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
PAUSED_FLAG="${BACKEND_DIR}/.watchdog-paused"

log() { echo "[start] $(date '+%F %T') $*"; }

# 用户显式启动 → 清除看门狗暂停标记
rm -f "${PAUSED_FLAG}"

# 已在运行则跳过：只看是否有 LISTEN 进程，避免客户端连接（panel/Chrome
# 连到 4211）造成"已在运行"误判而跳过启动，导致服务起不来。
if [ -n "$(lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null || true)" ]; then
  log "已在运行（端口 ${PORT} 监听中），跳过"
  exit 0
fi

# 必须已由 deployment 同步过来的构建产物
[ -f "${BACKEND_DIR}/dist/index.js" ] || {
  echo "[start][错误] 未找到 ${BACKEND_DIR}/dist/index.js，请先 /Users/gaolei/deployment/web-cursor/bin/release.sh && bin/deploy.sh deployment-<hash>" >&2
  exit 1
}

mkdir -p "${BACKEND_DIR}" "${REPORT_DIR}"

# 版本优先：环境变量 → runtime/VERSION → 兼容旧 git HEAD
if [ -n "${APP_VERSION:-}" ]; then
  :
elif [ -f "${RUNTIME_DIR}/VERSION" ]; then
  APP_VERSION="$(tr -d '[:space:]' < "${RUNTIME_DIR}/VERSION")"
elif [ -d "${RUNTIME_DIR}/.git" ]; then
  APP_VERSION="$(git -C "${RUNTIME_DIR}" rev-parse --short=8 HEAD 2>/dev/null || echo dev)"
else
  APP_VERSION="dev"
fi
export APP_VERSION

rotate_log() {
  local file="$1"
  [ -f "${file}" ] || return 0
  local size
  size="$(wc -c < "${file}" 2>/dev/null || echo 0)"
  if [ "${size}" -gt "${LOG_MAX_BYTES}" ]; then
    rm -f "${file}.${LOG_BACKUPS}"
    local i=$((LOG_BACKUPS - 1))
    while [ "${i}" -ge 1 ]; do
      if [ -f "${file}.${i}" ]; then
        mv "${file}.${i}" "${file}.$((i + 1))"
      fi
      i=$((i - 1))
    done
    mv "${file}" "${file}.1"
    log "日志已轮转：${file} → ${file}.1（旧大小 ${size} bytes）"
  fi
}
rotate_log "${LOG_FILE}"

cd "${BACKEND_DIR}"

# supervise-node.sh 是 node 的直接父进程：它记录真实 node PID 与退出码/信号。
# 这里统一追加日志，不再用 > 覆盖 server.log。
nohup env APP_VERSION="${APP_VERSION}" bash "${SCRIPT_DIR}/supervise-node.sh" "${BACKEND_DIR}" >> "${LOG_FILE}" 2>&1 &
SUPERVISOR_PID=$!
echo "${SUPERVISOR_PID}" > "${SUPERVISOR_PID_FILE}"

# 等待 supervisor 写入 node PID（短超时）
NEW_PID=""
for _ in $(seq 1 50); do
  if [ -f "${PID_FILE}" ]; then
    NEW_PID="$(tr -d '[:space:]' < "${PID_FILE}" 2>/dev/null || true)"
    [ -n "${NEW_PID}" ] && break
  fi
  sleep 0.1
done
log "supervisor PID=${SUPERVISOR_PID} node PID=${NEW_PID:-unknown} APP_VERSION=${APP_VERSION}"

if [ -z "${NEW_PID}" ]; then
  echo "[start][错误] supervisor 未能在 5 秒内写入 node PID，最近日志：" >&2
  tail -20 "${LOG_FILE}" >&2
  kill "${SUPERVISOR_PID}" 2>/dev/null || true
  exit 1
fi

# Align with ops deploy grace window (DEPLOY_MAX_SEC, default 120).
START_MAX_SEC="${START_MAX_SEC:-120}"
for _ in $(seq 1 "${START_MAX_SEC}"); do
  if ! kill -0 "${NEW_PID}" 2>/dev/null; then
    echo "[start][错误] node 进程提前退出，最近日志：" >&2
    tail -20 "${LOG_FILE}" >&2
    if [ -f "${EXIT_STATUS_FILE}" ]; then
      echo "[start][错误] node 退出状态：" >&2
      cat "${EXIT_STATUS_FILE}" >&2
    fi
    exit 1
  fi
  if curl -s -m 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    log "启动成功: ${HEALTH_URL}"
    exit 0
  fi
  sleep 1
done
echo "[start][错误] 健康检查未通过（${START_MAX_SEC} 秒超时），最近日志：" >&2
tail -20 "${LOG_FILE}" >&2
if [ -f "${EXIT_STATUS_FILE}" ]; then
  echo "[start][错误] node 退出状态：" >&2
  cat "${EXIT_STATUS_FILE}" >&2
fi
kill "${SUPERVISOR_PID}" 2>/dev/null || true
exit 1
