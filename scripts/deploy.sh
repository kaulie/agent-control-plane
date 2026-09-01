#!/usr/bin/env bash
#
# 标准部署脚本：把 dev 仓库的某个版本安全地部署到 runtime 并重启。
#
# 用法：
#   ./deploy.sh                  # 部署 dev 的 main 最新提交
#   ./deploy.sh <commit-hash>    # 部署某个 commit
#   ./deploy.sh deployment-<hash> # 部署某个 tag（版本）
#
# 约束：只允许用 git 同步 runtime（禁止 cp/rsync/直接改文件），
#       并且每步校验、失败即停，避免把线上搞挂。
#
set -euo pipefail

RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
BACKEND_DIR="${RUNTIME_DIR}/backend"
PID_FILE="${BACKEND_DIR}/runtime.pid"
LOG_FILE="${BACKEND_DIR}/server.log"
PORT="${PORT:-4211}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
TARGET="${1:-main}"
# 分支名统一解析到远程引用，避免用到 runtime 里过期的本地分支
case "${TARGET}" in
  main) TARGET="origin/main" ;;
  master) TARGET="origin/master" ;;
esac

log() { echo "[deploy] $*"; }
die() { echo "[deploy][错误] $*" >&2; exit 1; }

[ -d "${RUNTIME_DIR}/.git" ] || die "runtime 目录不存在或不是 git 仓库: ${RUNTIME_DIR}"

# ---- 1. 同步 git（只允许 git，禁止直接复制文件） ----
log "1/5 同步 runtime 到版本: ${TARGET}"
git -C "${RUNTIME_DIR}" fetch origin || die "git fetch 失败"
git -C "${RUNTIME_DIR}" reset --hard "${TARGET}" || die "git reset --hard ${TARGET} 失败"
VERSION=$(git -C "${RUNTIME_DIR}" rev-parse --short=8 HEAD)
log "    版本号: ${VERSION}"

# ---- 2. 构建 ----
log "2/5 构建"
(cd "${RUNTIME_DIR}" && npm run build) || die "构建失败"

# ---- 3. 停止旧进程（PID 文件 + 端口兜底） ----
log "3/5 停止旧进程"
if [ -f "${PID_FILE}" ]; then
  OLD=$(cat "${PID_FILE}" 2>/dev/null || true)
  if [ -n "${OLD}" ] && kill -0 "${OLD}" 2>/dev/null; then
    kill "${OLD}" 2>/dev/null || true
    log "    已停止 PID=${OLD}"
  fi
  rm -f "${PID_FILE}"
fi
PORT_PIDS=$(lsof -ti:${PORT} 2>/dev/null || true)
if [ -n "${PORT_PIDS}" ]; then
  kill ${PORT_PIDS} 2>/dev/null || true
  log "    按端口清理 PID=${PORT_PIDS}"
fi
sleep 2

# ---- 4. 启动新进程 ----
log "4/5 启动新进程"
mkdir -p "${BACKEND_DIR}"
cd "${BACKEND_DIR}"
nohup node dist/index.js > "${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" > "${PID_FILE}"
log "    新进程 PID=${NEW_PID}"

# ---- 5. 健康检查 ----
log "5/5 健康检查（最多 30 秒）"
OK=0
for _ in $(seq 1 30); do
  if curl -s -m 2 "${HEALTH_URL}" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 1
done
if [ "${OK}" != "1" ]; then
  die "健康检查未通过（30 秒超时）。最近日志：\n$(tail -20 "${LOG_FILE}")"
fi

log "部署完成 ✓  版本=${VERSION}  地址=http://localhost:${PORT}"
