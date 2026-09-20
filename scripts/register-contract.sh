#!/usr/bin/env bash
#
# 服务契约登记（服务中心）—— CI / 发版脚本的「一行入口」。
#
# 对等物：Go 服务跑 `client/ci/register-go-service.sh`（里面带 `swag init`）。
# 本服务没有代码生成器，契约是**提交进仓库**的 `api/openapi.json`：
#
#   route-meta.ts + 真实路由表 ──gen-openapi.mjs──▶ api/openapi.json ──本脚本──▶ 服务中心
#        （「注解」的唯一真源）        （swag init 的对等物）      （register.sh）
#
# 所以这里只做「读提交好的契约 + 幂等上报」；契约与路由是否一致由 CI 的
# `npm run openapi:check` 兜住（改接口忘了更新契约 → 红）。
#
# 用法：
#   bash scripts/register-contract.sh              # 幂等：重复跑无副作用
#   bash scripts/register-contract.sh --dry-run    # 只探活 + 打印将要执行的命令，不写库
#
# 环境变量（全部可选，默认值 = 本机部署现状）：
#   SERVICE_NAME         默认 agent-control-plane（= 仓库名；服务中心里已有的那条）
#   REGISTRY_URL         默认 http://127.0.0.1:${REGISTRY_PORT:-4240}
#   REGISTRY_NS          默认 default
#   REGISTRY_TOKEN       写令牌（现在写接口默认开放，可留空）
#   DEPARTMENT_ID        默认 D0005（AI研发部 = 本项目项目设置里选的部门）
#   INSTANCES            默认 127.0.0.1:${SERVICE_PORT:-4211}（多个用逗号分隔）
#   OWNER / VERSION      默认 kaulie / ${APP_VERSION:-package.json 的 version}
#   HEALTH_PATH          默认 /health
#   GIT_REPO             默认 git remote.origin.url，取不到用仓库常量
#   SPEC_FILE            默认 api/openapi.json
#   TAGS                 可选，逗号分隔的标签
#   REGISTRY_CLIENT_DIR  指到 service-registry 仓库的本地 checkout（用它的 client/register.sh）
#   REGISTRY_CLIENT_ALLOW_CLONE=0  禁止自动浅克隆（离线环境）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log() { echo "[register-contract] $*"; }
die() { echo "[register-contract][错误] $*" >&2; exit 1; }

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SERVICE_NAME="${SERVICE_NAME:-agent-control-plane}"
REGISTRY_URL="${REGISTRY_URL:-http://127.0.0.1:${REGISTRY_PORT:-4240}}"
REGISTRY_NS="${REGISTRY_NS:-default}"
DEPARTMENT_ID="${DEPARTMENT_ID:-D0005}"
INSTANCES="${INSTANCES:-127.0.0.1:${SERVICE_PORT:-4211}}"
OWNER="${OWNER:-kaulie}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
SPEC_FILE="${SPEC_FILE:-${ROOT}/api/openapi.json}"
TAGS="${TAGS:-}"
GIT_REPO="${GIT_REPO:-$(git -C "${ROOT}" config --get remote.origin.url 2>/dev/null || true)}"
GIT_REPO="${GIT_REPO:-https://github.com/kaulie/agent-control-plane}"
if [ -z "${VERSION:-}" ]; then
  VERSION="${APP_VERSION:-$(node -e "process.stdout.write(require('${ROOT}/package.json').version)" 2>/dev/null || echo 0.0.0)}"
fi

[ -f "${SPEC_FILE}" ] || die "找不到契约文件 ${SPEC_FILE}：先跑 \`npm run openapi:gen\` 并提交（CI 里用 \`npm run openapi:check\` 兜住忘更新）"

# 注册中心默认只绑 127.0.0.1：够不到时先给个明确提示，别让人以为契约有问题。
if ! curl -sS -m 5 "${REGISTRY_URL}/v1/meta" >/dev/null 2>&1; then
  log "提示：${REGISTRY_URL}/v1/meta 探活失败 —— 注册中心只绑 127.0.0.1，非本机 / GitHub-hosted runner 够不到（要跑在本机或 self-hosted runner 上）"
fi

# ---- 找服务中心的客户端脚本（register.sh 在 service-registry 仓库的 client/）----
CLIENT=""
find_client() {
  if [ -n "${REGISTRY_CLIENT_DIR:-}" ]; then
    [ -f "${REGISTRY_CLIENT_DIR}/client/register.sh" ] ||
      die "REGISTRY_CLIENT_DIR 里没有 client/register.sh：${REGISTRY_CLIENT_DIR}"
    CLIENT="${REGISTRY_CLIENT_DIR}/client/register.sh"
    return
  fi
  local cand
  for cand in "${ROOT}/../service-registry" "${HOME}/Projects/service-registry" "${HOME}/service-registry"; do
    if [ -f "${cand}/client/register.sh" ]; then
      CLIENT="${cand}/client/register.sh"
      return
    fi
  done
  if [ "${REGISTRY_CLIENT_ALLOW_CLONE:-1}" = "1" ]; then
    local tmp
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/registry-client.XXXXXX")"
    log "本地没有 service-registry 源码 → 浅克隆到 ${tmp}（离线可设 REGISTRY_CLIENT_DIR 或 REGISTRY_CLIENT_ALLOW_CLONE=0）"
    git clone --depth 1 --quiet https://github.com/kaulie/service-registry.git "${tmp}" >/dev/null 2>&1 ||
      die "克隆 service-registry 失败（设 REGISTRY_CLIENT_DIR 指到本地 checkout）"
    CLIENT="${tmp}/client/register.sh"
    return
  fi
  die "找不到 client/register.sh：设 REGISTRY_CLIENT_DIR 指到 service-registry 仓库"
}
find_client

ARGS=(
  --service "${SERVICE_NAME}"
  --file "${SPEC_FILE}"
  --version "${VERSION}"
  --owner "${OWNER}"
  --health-path "${HEALTH_PATH}"
  --department "${DEPARTMENT_ID}"
  --git-repo "${GIT_REPO}"
  --ns "${REGISTRY_NS}"
  --url "${REGISTRY_URL}"
)
OLD_IFS="${IFS}"; IFS=','
for inst in ${INSTANCES}; do
  [ -n "${inst}" ] && ARGS+=(--instance "${inst}")
done
for tag in ${TAGS}; do
  [ -n "${tag}" ] && ARGS+=(--tag "${tag}")
done
IFS="${OLD_IFS}"

log "服务：${SERVICE_NAME}（${REGISTRY_NS}）· 部门 ${DEPARTMENT_ID} · 实例 ${INSTANCES} · 版本 ${VERSION}"
log "契约：${SPEC_FILE}"
log "客户端：${CLIENT}"

if [ "${DRY_RUN}" = "1" ]; then
  log "dry-run：不会写库。将执行 →"
  echo "    bash ${CLIENT} ${ARGS[*]}"
  exit 0
fi

REGISTRY_TOKEN="${REGISTRY_TOKEN:-}" bash "${CLIENT}" "${ARGS[@]}"

log "完成。服务详情：${REGISTRY_URL}/v1/namespaces/${REGISTRY_NS}/services/${SERVICE_NAME}"
log "控制面板：${REGISTRY_URL}/panel/"
