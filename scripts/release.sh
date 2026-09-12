#!/usr/bin/env bash
echo "[release] 请改用: ~/runtime/agent-control-plane-deployment/bin/release.sh $*" >&2
echo "[release] 部署系统已独立，禁止在 app workspace 内发版。" >&2
exec "${HOME}/runtime/agent-control-plane-deployment/bin/release.sh" "$@"
