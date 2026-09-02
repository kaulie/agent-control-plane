#!/usr/bin/env bash
#
# 打出发版包：把某个 git ref 冻结为 deployment-<hash>，并在快照目录内完成 install + build。
#
# 用法：
#   ./scripts/release.sh                 # 默认 origin/main（或 main）
#   ./scripts/release.sh <ref|sha>       # 指定 commit / 分支 / tag
#
# 产物目录：
#   /Users/gaolei/deployment/web-cursor/deployment-<hash>/
#
# 下一步：
#   ./scripts/deploy.sh deployment-<hash>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOYMENT_ROOT="${DEPLOYMENT_ROOT:-/Users/gaolei/deployment/web-cursor}"
REF_INPUT="${1:-}"

log() { echo "[release] $*"; }
die() { echo "[release][错误] $*" >&2; exit 1; }

if [ -n "${REF_INPUT}" ]; then
  REF="${REF_INPUT}"
elif git -C "${REPO_ROOT}" rev-parse --verify origin/main >/dev/null 2>&1; then
  REF="origin/main"
elif git -C "${REPO_ROOT}" rev-parse --verify main >/dev/null 2>&1; then
  REF="main"
else
  die "无法解析默认 ref，请显式传入 commit/分支"
fi

log "解析版本: ${REF}"
FULL="$(git -C "${REPO_ROOT}" rev-parse "${REF}")" || die "无效 ref: ${REF}"
HASH="$(git -C "${REPO_ROOT}" rev-parse --short=8 "${FULL}")"
TAG="deployment-${HASH}"
DEST="${DEPLOYMENT_ROOT}/${TAG}"

log "commit=${FULL}"
log "hash=${HASH}"
log "tag=${TAG}"
log "dest=${DEST}"

# Tag（已存在且指向同一 commit 则复用；指向其它 commit 则失败）
if git -C "${REPO_ROOT}" rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  EXISTING="$(git -C "${REPO_ROOT}" rev-parse "${TAG}^{commit}")"
  if [ "${EXISTING}" != "${FULL}" ]; then
    die "tag ${TAG} 已存在但指向 ${EXISTING}，与目标 ${FULL} 不一致"
  fi
  log "复用已有 tag ${TAG}"
else
  git -C "${REPO_ROOT}" tag -a "${TAG}" "${FULL}" -m "Release ${TAG}"
  log "已创建本地 tag ${TAG}"
fi

# 尽力推送 tag（网络失败不阻断本地发版包）
if git -C "${REPO_ROOT}" remote get-url origin >/dev/null 2>&1; then
  if git -C "${REPO_ROOT}" push origin "refs/tags/${TAG}" 2>/dev/null; then
    log "已推送 tag ${TAG} → origin"
  else
    log "警告: 推送 tag 失败（可稍后手动 git push origin ${TAG}），继续生成本地快照"
  fi
fi

mkdir -p "${DEPLOYMENT_ROOT}"

NEED_BUILD=1
if [ -f "${DEST}/VERSION" ] && [ -f "${DEST}/backend/dist/index.js" ]; then
  OLD="$(tr -d '[:space:]' < "${DEST}/VERSION" || true)"
  if [ "${OLD}" = "${HASH}" ]; then
    log "快照已存在且已构建，跳过重建: ${DEST}"
    NEED_BUILD=0
  else
    die "目录 ${DEST} 已存在但 VERSION=${OLD}，与 ${HASH} 不符；请手动处理后再试"
  fi
fi

if [ "${NEED_BUILD}" -eq 1 ]; then
  if [ -e "${DEST}" ]; then
    log "清理不完整快照: ${DEST}"
    rm -rf "${DEST}"
  fi
  mkdir -p "${DEST}"
  log "导出源码到快照目录"
  git -C "${REPO_ROOT}" archive "${FULL}" | tar -x -C "${DEST}"
  printf '%s\n' "${HASH}" > "${DEST}/VERSION"
  printf '%s\n' "${FULL}" > "${DEST}/COMMIT"

  log "在快照内 npm install + build（APP_VERSION=${HASH}）"
  (
    cd "${DEST}"
    export APP_VERSION="${HASH}"
    npm install
    npm run build
  ) || die "快照构建失败"

  [ -f "${DEST}/backend/dist/index.js" ] || die "缺少 backend/dist/index.js"
  [ -f "${DEST}/web/dist/index.html" ] || die "缺少 web/dist/index.html"
  log "构建完成"
fi

log "发版包就绪 ✓"
log "  目录: ${DEST}"
log "  下一步: ./scripts/deploy.sh ${TAG}"
