#!/usr/bin/env bash
# Unit tests for scripts/assert-web-dist.sh (no npm build).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSERT="${ROOT}/scripts/assert-web-dist.sh"
failed=0

expect() {
  local name="$1" want="$2"
  shift 2
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  if [ "${status}" -eq "${want}" ]; then
    echo "  ok   ${name}"
  else
    echo "  FAIL ${name} (exit ${status}, want ${want})" >&2
    failed=$((failed + 1))
  fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/assert-web-dist.XXXXXX")"
trap 'rm -rf "${tmp}"' EXIT

# 1) complete SPA with matching hash
good="${tmp}/good"
mkdir -p "${good}/assets"
printf '%s\n' '<script src="/assets/index-AAA.js"></script><link href="/assets/index-AAA.css">' > "${good}/index.html"
printf '%s\n' 'const v="abc12345";' > "${good}/assets/index-AAA.js"
printf '%s\n' 'body{}' > "${good}/assets/index-AAA.css"
expect "complete dist + version" 0 bash "${ASSERT}" "${good}" --version abc12345

# 2) HTML only
html_only="${tmp}/html-only"
mkdir -p "${html_only}"
printf '%s\n' '<div id="root"></div>' > "${html_only}/index.html"
expect "html without assets dir" 1 bash "${ASSERT}" "${html_only}"

# 3) HTML + CSS, no JS (the production blank-page case)
no_js="${tmp}/no-js"
mkdir -p "${no_js}/assets"
printf '%s\n' '<script src="/assets/index-AAA.js"></script><link href="/assets/index-AAA.css">' > "${no_js}/index.html"
printf '%s\n' 'body{}' > "${no_js}/assets/index-AAA.css"
expect "html+css missing js" 1 bash "${ASSERT}" "${no_js}"

# 4) JS present but index.html points at a different hash
mismatch="${tmp}/mismatch"
mkdir -p "${mismatch}/assets"
printf '%s\n' '<script src="/assets/index-OLD.js"></script>' > "${mismatch}/index.html"
printf '%s\n' 'const v="abc12345";' > "${mismatch}/assets/index-NEW.js"
expect "html hash != files on disk" 1 bash "${ASSERT}" "${mismatch}"

# 5) files complete but version not baked
no_ver="${tmp}/no-ver"
mkdir -p "${no_ver}/assets"
printf '%s\n' '<script src="/assets/index-AAA.js"></script>' > "${no_ver}/index.html"
printf '%s\n' 'const v="dev";' > "${no_ver}/assets/index-AAA.js"
expect "missing baked version" 1 bash "${ASSERT}" "${no_ver}" --version abc12345
expect "dev version skips bake check" 0 bash "${ASSERT}" "${no_ver}" --version dev
expect "no --version skips bake check" 0 bash "${ASSERT}" "${no_ver}"

if [ "${failed}" -ne 0 ]; then
  echo "${failed} assert-web-dist check(s) failed" >&2
  exit 1
fi
echo "PASS: assert-web-dist"
