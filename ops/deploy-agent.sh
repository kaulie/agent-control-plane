#!/usr/bin/env bash
# Independent deploy agent (deployment domain — NOT under runtime).
# Watches deploy-requests/ and runs bin/deploy.sh so the gateway never
# restarts itself from inside an agent shell.
#
# Request file (JSON):
#   { "requestId":"deploy-req-…", "deployment":"deployment-<hash>" }
# Status file written to deploy-status/<requestId>.json
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_HOME="${DEPLOY_HOME:-$(cd "${OPS_DIR}/.." && pwd)}"
RUNTIME_DIR="${RUNTIME_DIR:-/Users/gaolei/runtime/web-cursor}"
REQUESTS_DIR="${DEPLOY_HOME}/deploy-requests"
STATUS_DIR="${DEPLOY_HOME}/deploy-status"
PROCESSING_DIR="${REQUESTS_DIR}/processing"
DEPLOY_SH="${DEPLOY_HOME}/bin/deploy.sh"
INTERVAL="${DEPLOY_AGENT_INTERVAL:-2}"
PID_FILE="${OPS_DIR}/deploy-agent.pid"

mkdir -p "${REQUESTS_DIR}" "${STATUS_DIR}" "${PROCESSING_DIR}"
echo $$ > "${PID_FILE}"
trap 'rm -f "${PID_FILE}"' EXIT

log() { echo "[deploy-agent] $(date '+%F %T') $*"; }

write_status() {
  local file="$1"
  local tmp="${file}.tmp.$$"
  cat > "${tmp}"
  mv "${tmp}" "${file}"
}

process_one() {
  local src="$1"
  local base
  base="$(basename "${src}")"
  local processing="${PROCESSING_DIR}/${base}"

  # Claim atomically (mv fails if already taken).
  if ! mv "${src}" "${processing}" 2>/dev/null; then
    return 0
  fi

  local requestId deployment
  requestId="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("requestId",""))' "${processing}" 2>/dev/null || true)"
  deployment="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("deployment") or d.get("tag") or "")' "${processing}" 2>/dev/null || true)"

  if [ -z "${requestId}" ]; then
    requestId="${base%.json}"
  fi
  local status_file="${STATUS_DIR}/${requestId}.json"

  if [ -z "${deployment}" ]; then
    log "reject ${requestId}: missing deployment"
    write_status "${status_file}" <<EOF
{"requestId":"${requestId}","state":"failed","error":"missing deployment field","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
    rm -f "${processing}"
    return 0
  fi

  case "${deployment}" in
    deployment-*) ;;
    *)
      deployment="deployment-${deployment}"
      ;;
  esac

  log "start ${requestId} → ${deployment}"
  write_status "${status_file}" <<EOF
{"requestId":"${requestId}","state":"running","deployment":"${deployment}","startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF

  local err=""
  local rc=0
  if [ ! -x "${DEPLOY_SH}" ]; then
    err="deploy.sh not found: ${DEPLOY_SH}"
    rc=1
  else
    set +e
    "${DEPLOY_SH}" "${deployment}" >"${OPS_DIR}/deploy-agent.last.log" 2>&1
    rc=$?
    set -e
    if [ "${rc}" -ne 0 ]; then
      err="deploy.sh exited ${rc}"
    fi
  fi

  local version=""
  if [ -f "${RUNTIME_DIR}/VERSION" ]; then
    version="$(tr -d '[:space:]' < "${RUNTIME_DIR}/VERSION" || true)"
  fi

  if [ "${rc}" -eq 0 ]; then
    log "ok ${requestId} version=${version}"
    write_status "${status_file}" <<EOF
{"requestId":"${requestId}","state":"succeeded","deployment":"${deployment}","version":"${version}","finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
  else
    log "fail ${requestId}: ${err}"
    write_status "${status_file}" <<EOF
{"requestId":"${requestId}","state":"failed","deployment":"${deployment}","version":"${version}","error":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${err}"),"finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
  fi

  rm -f "${processing}"
}

log "start deployHome=${DEPLOY_HOME} interval=${INTERVAL}s"

while true; do
  shopt -s nullglob
  for f in "${REQUESTS_DIR}"/*.json; do
    process_one "${f}"
  done
  shopt -u nullglob
  sleep "${INTERVAL}"
done
