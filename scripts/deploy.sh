#!/usr/bin/env bash
#
# 标准部署脚本：把 dev 仓库的某个版本安全地部署到 runtime 并重启。
#
# 用法：
#   ./scripts/deploy.sh                    # 部署 dev 的 main 最新
#   ./scripts/deploy.sh <commit-hash>      # 部署某个 commit
#   ./scripts/deploy.sh deployment-<hash>  # 部署某个版本 tag
#
# 约束：只允许用 git 同步 runtime（禁止 cp/rsync/直接改文件），
#       并且每步校验、失败即停，避免把线上搞挂。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
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
log "1/3 同步 runtime 到版本: ${TARGET}"
git -C "${RUNTIME_DIR}" fetch origin || die "git fetch 失败"
git -C "${RUNTIME_DIR}" reset --hard "${TARGET}" || die "git reset --hard ${TARGET} 失败"
VERSION=$(git -C "${RUNTIME_DIR}" rev-parse --short=8 HEAD)
log "    版本号: ${VERSION}"

# ---- 2. 构建 ----
log "2/3 安装依赖并构建"
export APP_VERSION="${VERSION}"
(cd "${RUNTIME_DIR}" && npm install && npm run build) || die "构建失败"

# ---- 3. 重启（复用 restart.sh：stop -> start -> 健康检查） ----
log "3/3 重启"
"${SCRIPT_DIR}/restart.sh"

log "部署完成 ✓  版本=${VERSION}"
