#!/usr/bin/env bash
#
# Project build for the independent release tool
# (/Users/gaolei/deployment/bin/release.sh).
#
# Expects to run from a clean source tree (git archive). Produces ./outputs/
# — a slim runnable snapshot (production deps + build artifacts only) that
# release freezes into deployment-<hash>/.
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
rsync -a \
  --exclude 'release.sh' \
  --exclude 'deploy.sh' \
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
