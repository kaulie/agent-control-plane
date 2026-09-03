#!/usr/bin/env bash
#
# Project build for the independent release tool
# (/Users/gaolei/deployment/bin/release.sh).
#
# Expects to run from a clean source tree (git archive). Produces ./outputs/
# — a runnable snapshot (install + build) that release freezes into
# deployment-<hash>/.
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

log "组装 outputs/"
rm -rf outputs
mkdir -p outputs

# Frozen package = full runnable tree (same shape as historical deployment-*).
rsync -a \
  --exclude '.git/' \
  --exclude 'outputs/' \
  --exclude 'backend/data/' \
  --exclude 'backend/.env' \
  --exclude 'backend/runtime.pid' \
  --exclude 'backend/server.log' \
  --exclude 'backend/.watchdog-paused' \
  ./ outputs/

[ -f outputs/scripts/restart.sh ] || die "outputs/ 缺少 scripts/restart.sh"
[ -f outputs/backend/dist/index.js ] || die "outputs/ 缺少 backend/dist/index.js"
[ -f outputs/web/dist/index.html ] || die "outputs/ 缺少 web/dist/index.html"

log "完成 → ${ROOT}/outputs/"
