#!/usr/bin/env bash
# 兼容提示：上线入口已迁到独立上线域，不再从 app 仓库 / workspace 执行。
echo "[deploy] 请改用: /Users/gaolei/deployment/web-cursor/bin/deploy.sh $*" >&2
echo "[deploy] 上线脚本独立于 web-cursor 仓库，禁止在 agent-workspace 内部署。" >&2
exec /Users/gaolei/deployment/web-cursor/bin/deploy.sh "$@"
