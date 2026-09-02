#!/usr/bin/env bash
#
# 将已构建的 deployment-<hash> 同步到 runtime 并重启（runtime 内不构建）。
#
# 用法：
#   ./scripts/deploy.sh deployment-<hash>
#   ./scripts/deploy.sh <8-char-hash>
#
# 约束：
#   - 必须指定精确版本（禁止无参部署漂浮 main）
#   - 只允许通过本脚本 rsync 更新 runtime 代码
#   - 永不覆盖 backend/.env 与 backend/data/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
DEPLOYMENT_ROOT="${DEPLOYMENT_ROOT:-/Users/gaolei/deployment/web-cursor}"

log() { echo "[deploy] $*"; }
die() { echo "[deploy][错误] $*" >&2; exit 1; }

[ "${1:-}" ] || die "用法: ./scripts/deploy.sh deployment-<hash>  （请先 ./scripts/release.sh）"

RAW="$1"
case "${RAW}" in
  deployment-*)
    TAG="${RAW}"
    HASH="${RAW#deployment-}"
    ;;
  *)
    HASH="${RAW}"
    TAG="deployment-${HASH}"
    ;;
esac

# 归一成 8 位短 hash 目录名（若传入更长 sha，取前 8 位目录惯例）
if [ "${#HASH}" -gt 8 ]; then
  HASH="${HASH:0:8}"
  TAG="deployment-${HASH}"
fi

SRC="${DEPLOYMENT_ROOT}/${TAG}"
[ -d "${SRC}" ] || die "快照不存在: ${SRC}（先运行 ./scripts/release.sh）"
[ -f "${SRC}/VERSION" ] || die "缺少 ${SRC}/VERSION"
[ -f "${SRC}/backend/dist/index.js" ] || die "快照未构建: 缺少 backend/dist/index.js"
[ -f "${SRC}/web/dist/index.html" ] || die "快照未构建: 缺少 web/dist/index.html"

SNAP_VER="$(tr -d '[:space:]' < "${SRC}/VERSION")"
[ "${SNAP_VER}" = "${HASH}" ] || die "VERSION(${SNAP_VER}) 与目录 hash(${HASH}) 不一致"

mkdir -p "${RUNTIME_DIR}"

log "1/2 rsync ${TAG} → ${RUNTIME_DIR}"
# P = protect on receiver: 不被 --delete 删掉；exclude 避免被源覆盖
rsync -a --delete \
  --filter='P backend/.env' \
  --filter='P backend/data/' \
  --filter='P backend/runtime.pid' \
  --filter='P backend/server.log' \
  --filter='P backend/.watchdog-paused' \
  --exclude='backend/.env' \
  --exclude='backend/data/' \
  --exclude='backend/runtime.pid' \
  --exclude='backend/server.log' \
  --exclude='backend/.watchdog-paused' \
  --exclude='.git/' \
  "${SRC}/" "${RUNTIME_DIR}/" || die "rsync 失败"

# 在 runtime 写入版本标记，供 start.sh 使用
printf '%s\n' "${HASH}" > "${RUNTIME_DIR}/VERSION"
printf '%s\n' "${TAG}" > "${RUNTIME_DIR}/DEPLOYMENT"

[ -f "${RUNTIME_DIR}/backend/dist/index.js" ] || die "同步后缺少 backend/dist/index.js"

log "2/2 重启 runtime（不构建）"
export APP_VERSION="${HASH}"
"${SCRIPT_DIR}/restart.sh" || die "重启失败"

log "部署完成 ✓  版本=${HASH}"
