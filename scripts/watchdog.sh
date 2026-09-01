#!/usr/bin/env bash
# 看门狗：监控 runtime 进程，崩溃后自动拉起（崩溃分析由后端在启动时自动发起）。
# 用法：nohup ./scripts/watchdog.sh > /tmp/web-cursor-watchdog.log 2>&1 &
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
BACKEND_DIR="${RUNTIME_DIR}/backend"
PAUSED_FLAG="${BACKEND_DIR}/.watchdog-paused"
PORT="${PORT:-4211}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
INTERVAL="${INTERVAL:-10}"

echo "[watchdog] 启动（每 ${INTERVAL}s 检查一次 ${HEALTH_URL}）"

while true; do
  if [ -f "${PAUSED_FLAG}" ]; then
    sleep "${INTERVAL}"
    continue
  fi
  if ! curl -s -m 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[watchdog] $(date '+%F %T') 服务不可用，自动拉起..."
    "${SCRIPT_DIR}/start.sh" || echo "[watchdog] start.sh 执行失败"
  fi
  sleep "${INTERVAL}"
done
