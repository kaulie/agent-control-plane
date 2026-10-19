#!/usr/bin/env bash
#
# Fail if a Vite SPA dist is missing hashed JS/CSS that index.html actually
# references. The deployment platform rsyncs this tree with --delete; a package
# that only has index.html will blank the live UI.
#
# Usage: assert-web-dist.sh <web/dist> [--version HASH]
#
set -euo pipefail

PREFIX="${ASSERT_WEB_DIST_PREFIX:-[web-dist]}"

die() { echo "${PREFIX} $*" >&2; exit 1; }

DIST=""
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "缺少 --version 的值"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    -*)
      die "未知参数 $1"
      ;;
    *)
      [ -z "${DIST}" ] || die "多余参数 $1"
      DIST="$1"
      shift
      ;;
  esac
done

[ -n "${DIST}" ] || die "用法: assert-web-dist.sh <web/dist> [--version HASH]"
[ -d "${DIST}" ] || die "不是目录: ${DIST}"

HTML="${DIST}/index.html"
[ -f "${HTML}" ] || die "缺少 ${HTML}"

ASSETS="${DIST}/assets"
[ -d "${ASSETS}" ] || die "缺少 ${ASSETS}/（没有 hashed 资源，部署后页面会空白）"

js_count=0
for f in "${ASSETS}"/*.js; do
  [ -f "${f}" ] || continue
  js_count=$((js_count + 1))
done
[ "${js_count}" -ge 1 ] || die "${ASSETS}/ 没有 *.js（只有 HTML 不够，rsync --delete 会把线上脚本删掉）"

# Every /assets/... (or assets/...) referenced by index.html must exist on disk.
# Vite emits e.g. src="/assets/index-HASH.js" and href="/assets/index-HASH.css".
while IFS= read -r ref; do
  [ -n "${ref}" ] || continue
  rel="${ref#/}"
  [ -f "${DIST}/${rel}" ] || die "index.html 引用了 ${ref} 但 ${DIST}/${rel} 不存在"
done <<EOF
$(grep -oE '(src|href)="[^"]*assets/[^"]+"' "${HTML}" | sed -E 's/^(src|href)="//; s/"$//' || true)
EOF

if [ -n "${VERSION}" ] && [ "${VERSION}" != "dev" ]; then
  found=0
  for f in "${ASSETS}"/*.js; do
    [ -f "${f}" ] || continue
    if grep -F -q "\"${VERSION}\"" "${f}"; then
      found=1
      break
    fi
  done
  [ "${found}" -eq 1 ] || die "SPA 未烘焙 APP_VERSION=${VERSION}（页脚会显示 vdev）"
fi
