#!/usr/bin/env bash
# 重启 runtime（不构建；构建请用 deploy.sh）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[restart] 停止..."
"${SCRIPT_DIR}/stop.sh"
sleep 1
echo "[restart] 启动..."
"${SCRIPT_DIR}/start.sh"
echo "[restart] 完成"
