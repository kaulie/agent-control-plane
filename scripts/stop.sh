#!/usr/bin/env bash
# 停止 runtime 进程。
set -euo pipefail

RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
BACKEND_DIR="${RUNTIME_DIR}/backend"
PID_FILE="${BACKEND_DIR}/runtime.pid"
# 与 start.sh 同一套端口解析：SERVICE_PORT → PORT → 4211。
PORT="${SERVICE_PORT:-${PORT:-4211}}"
PAUSED_FLAG="${BACKEND_DIR}/.watchdog-paused"

stopped=0

# 1) 按 PID 文件停止
if [ -f "${PID_FILE}" ]; then
  OLD=$(cat "${PID_FILE}" 2>/dev/null || true)
  if [ -n "${OLD}" ] && kill -0 "${OLD}" 2>/dev/null; then
    kill "${OLD}" 2>/dev/null || true
    echo "[stop] 已停止 PID=${OLD}"
    stopped=1
  fi
  rm -f "${PID_FILE}"
fi

# 2) 按端口兜底清理：只杀 LISTEN 进程，避免误杀连到该端口的客户端
#    （如部署系统 control-plane 的 graceful poll 空闲 keep-alive 连接）
PORT_PIDS=$(lsof -ti:${PORT} -sTCP:LISTEN 2>/dev/null || true)
if [ -n "${PORT_PIDS}" ]; then
  kill ${PORT_PIDS} 2>/dev/null || true
  echo "[stop] 按端口清理监听进程 PID=${PORT_PIDS}"
  stopped=1
fi

if [ "${stopped}" = "1" ]; then
  echo "[stop] 已停止"
else
  echo "[stop] 没有正在运行的进程"
fi

# 用户显式停止 → 设置看门狗暂停标记，避免被自动拉起（运行 start.sh 会清除）
touch "${PAUSED_FLAG}"
echo "[stop] 已设置看门狗暂停标记"
