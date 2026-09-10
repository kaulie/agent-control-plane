#!/usr/bin/env bash
# 作为 node 的直接父进程运行 gateway，记录真实 node PID 与退出码/信号。
# 用法：supervise-node.sh <backend_dir>
# 依赖环境变量：APP_VERSION（可空）。
set -euo pipefail

BACKEND_DIR="${1:-}"
if [ -z "${BACKEND_DIR}" ]; then
  echo "[supervise-node][错误] 缺少 backend_dir 参数" >&2
  exit 2
fi

PID_FILE="${BACKEND_DIR}/runtime.pid"
EXIT_STATUS_FILE="${BACKEND_DIR}/node-exit.status"
REPORT_DIR="${BACKEND_DIR}/reports"
LOG_FILE="${BACKEND_DIR}/server.log"

mkdir -p "${BACKEND_DIR}" "${REPORT_DIR}"
cd "${BACKEND_DIR}"

APP_VERSION="${APP_VERSION:-dev}"
REPORT_BASENAME="node-report.$(date +%Y%m%dT%H%M%S).$$"

# Node fatal report：fatal error / uncaught exception / 指定信号时落盘到 reports/。
# 追加写日志，禁止覆盖。
node \
  --report-on-fatalerror \
  --report-uncaught-exception \
  --report-on-signal \
  --report-dir="${REPORT_DIR}" \
  --report-filename="${REPORT_BASENAME}" \
  dist/index.js >>"${LOG_FILE}" 2>&1 &
CHILD_PID=$!
echo "${CHILD_PID}" > "${PID_FILE}"

forward_signal() {
  kill "${CHILD_PID}" 2>/dev/null || true
}
trap forward_signal TERM INT HUP

set +e
wait "${CHILD_PID}"
rc=$?
set -e

signal=""
if [ "${rc}" -gt 128 ]; then
  signal=$((rc - 128))
fi

{
  echo "pid=${CHILD_PID}"
  echo "exitCode=${rc}"
  echo "signal=${signal}"
  echo "exitedAt=$(date '+%F %T')"
} > "${EXIT_STATUS_FILE}"

rm -f "${PID_FILE}"
exit "${rc}"