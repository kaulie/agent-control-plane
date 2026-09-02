#!/usr/bin/env bash
# 兼容提示：发版入口已迁到独立上线域，不再从 app 仓库 / workspace 执行。
echo "[release] 请改用: /Users/gaolei/deployment/web-cursor/bin/release.sh $*" >&2
echo "[release] 发版脚本独立于 web-cursor 仓库，禁止在 agent-workspace 内发版。" >&2
exec /Users/gaolei/deployment/web-cursor/bin/release.sh "$@"
