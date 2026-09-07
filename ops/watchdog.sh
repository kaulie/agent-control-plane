#!/usr/bin/env bash
# Independent ops watchdog (deployment domain — NOT under runtime).
# Survives app restarts; only pulls the runtime process back up.
#
# Usage:
#   nohup /Users/gaolei/deployment/web-cursor/ops/watchdog.sh \
#     >> /Users/gaolei/deployment/web-cursor/ops/watchdog.log 2>&1 &
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_HOME="${DEPLOY_HOME:-$(cd "${OPS_DIR}/.." && pwd)}"
RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
BACKEND_DIR="${RUNTIME_DIR}/backend"
START_SH="${RUNTIME_DIR}/scripts/start.sh"
PAUSED_FLAG="${BACKEND_DIR}/.watchdog-paused"
PORT="${PORT:-4211}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
INTERVAL="${WATCHDOG_INTERVAL:-10}"
PID_FILE="${OPS_DIR}/watchdog.pid"

mkdir -p "${OPS_DIR}"
echo $$ > "${PID_FILE}"
trap 'rm -f "${PID_FILE}"' EXIT

echo "[ops-watchdog] start deployHome=${DEPLOY_HOME} runtime=${RUNTIME_DIR} every ${INTERVAL}s → ${HEALTH_URL}"

while true; do
  if [ -f "${PAUSED_FLAG}" ]; then
    sleep "${INTERVAL}"
    continue
  fi
  if ! curl -s -m 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[ops-watchdog] $(date '+%F %T') unhealthy; starting runtime..."
    if [ -x "${START_SH}" ]; then
      RUNTIME_DIR="${RUNTIME_DIR}" "${START_SH}" \
        || echo "[ops-watchdog] start.sh failed"
    else
      echo "[ops-watchdog] missing ${START_SH}"
    fi
  fi
  sleep "${INTERVAL}"
done
