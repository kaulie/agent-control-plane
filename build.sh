#!/usr/bin/env bash
#
# Project build for the independent deployment platform
# (agent-control-plane-deployment). The platform checks out a git ref and runs
# this script inside the build tree.
#
# Expects to run from a clean source tree (git archive). Produces ./outputs/
# — a slim runnable snapshot (production deps + build artifacts only) that the
# platform freezes into deployment-<hash>/.
#
# outputs/ intentionally excludes TypeScript sources, docs, tests, and
# build-time tooling. node_modules is included (production / omit=dev).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

log() { echo "[build] $*"; }
die() { echo "[build][错误] $*" >&2; exit 1; }

HASH="${APP_VERSION:-dev}"
log "APP_VERSION=${HASH}"

log "npm install"
npm install

log "npm install mcp-servers/git-via-proxy"
npm install --omit=dev --prefix mcp-servers/git-via-proxy

log "npm run build"
export APP_VERSION="${HASH}"
npm run build

[ -f backend/dist/index.js ] || die "缺少 backend/dist/index.js"
[ -f web/dist/index.html ] || die "缺少 web/dist/index.html"
[ -f scripts/restart.sh ] || die "缺少 scripts/restart.sh"
[ -f mcp-servers/git-via-proxy/server.mjs ] || die "缺少 mcp-servers/git-via-proxy/server.mjs"
[ -d mcp-servers/git-via-proxy/node_modules ] || die "缺少 mcp-servers/git-via-proxy/node_modules（先 npm install --prefix mcp-servers/git-via-proxy）"

log "npm prune --omit=dev（瘦身生产依赖）"
npm prune --omit=dev

log "组装 outputs/（仅部署所需）"
rm -rf outputs
mkdir -p \
  outputs/backend/dist \
  outputs/web/dist \
  outputs/scripts \
  outputs/mcp-servers/git-via-proxy

# Workspace manifests (needed for node module resolution).
cp package.json package-lock.json outputs/
cp backend/package.json outputs/backend/
cp web/package.json outputs/web/

# Build artifacts.
rsync -a backend/dist/ outputs/backend/dist/
rsync -a web/dist/ outputs/web/dist/

# Runtime ops scripts (start/stop/restart/watchdog/…).
# register-contract.sh 是 CI / 发版用的（服务中心契约登记），不进运行时快照。
rsync -a \
  --exclude 'release.sh' \
  --exclude 'register-contract.sh' \
  scripts/ outputs/scripts/

# MCP helper (already production-installed).
rsync -a \
  --exclude 'README.md' \
  mcp-servers/git-via-proxy/ outputs/mcp-servers/git-via-proxy/

# Production node_modules from the pruned build tree.
rsync -a node_modules/ outputs/node_modules/

[ -f outputs/scripts/restart.sh ] || die "outputs/ 缺少 scripts/restart.sh"
[ -f outputs/backend/dist/index.js ] || die "outputs/ 缺少 backend/dist/index.js"
[ -f outputs/web/dist/index.html ] || die "outputs/ 缺少 web/dist/index.html"
[ -d outputs/node_modules ] || die "outputs/ 缺少 node_modules"
[ -f outputs/mcp-servers/git-via-proxy/server.mjs ] || die "outputs/ 缺少 mcp-servers/git-via-proxy/server.mjs"

log "完成 → ${ROOT}/outputs/"
du -sh outputs outputs/node_modules outputs/backend outputs/web outputs/mcp-servers 2>/dev/null || true

# ---- 服务中心契约登记（CI / 发版脚本末尾那一行）----
# 与 Go 服务的 `client/ci/register-go-service.sh` 对等：读**提交进仓库**的契约
# （api/openapi.json，由 backend/scripts/gen-openapi.mjs 从路由 + route-meta.ts 生成）
# 幂等上报（服务 + 实例集合）。默认开；REGISTER_CONTRACT=0 关闭。
# 失败默认**不**影响构建产物（契约元信息不该拦住发版）：加
# REGISTER_CONTRACT_STRICT=1 让失败直接失败；手动重跑：bash scripts/register-contract.sh
if [ "${REGISTER_CONTRACT:-1}" = "0" ]; then
  log "服务中心契约登记已关闭（REGISTER_CONTRACT=0）"
else
  log "服务中心契约登记（scripts/register-contract.sh；REGISTER_CONTRACT=0 可关闭）"
  if bash "${ROOT}/scripts/register-contract.sh"; then
    :
  elif [ "${REGISTER_CONTRACT_STRICT:-0}" = "1" ]; then
    die "服务中心契约登记失败（REGISTER_CONTRACT_STRICT=1）"
  else
    log "警告：服务中心契约登记失败，但构建产物已生成（重跑：bash scripts/register-contract.sh）"
  fi
fi
