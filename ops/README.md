# Independent ops daemons (deployment domain)

These processes live under `/Users/gaolei/deployment/web-cursor/ops/` and must
**not** run from `runtime/`. They survive gateway restarts.

| Daemon | Role |
|---|---|
| `watchdog.sh` | Health-check `:4211`; call runtime `scripts/start.sh` if down |
| `deploy-agent.sh` | Watch `deploy-requests/*.json` and run `bin/deploy.sh` |

### Deploy grace (2 minutes)

Before each deploy, `deploy-agent` writes `ops/watchdog-pause-until` (unix epoch =
now + `DEPLOY_MAX_SEC`, default **120**). While that pause is active the
watchdog will **not** auto-start. If the service is still down when the pause
expires, the watchdog clears the pause flags and starts runtime itself.

`deploy-agent` also kills `bin/deploy.sh` if it exceeds the same 120s budget.
On a healthy success it clears the pause early.

## Install / start

From a checkout of this repo (or after merge, from a release tree):

```bash
DEPLOY_HOME=/Users/gaolei/deployment/web-cursor bash ops/install.sh
```

That copies scripts into `deployment/web-cursor/ops/` and starts both daemons.

## Request a deploy (no self-kill)

Prefer the gateway API (returns immediately).

**Config** (backend `.env`):

| Env | Default | Meaning |
|---|---|---|
| `GRACEFUL_RESTART` / `graceful_restart` | `1` | `1` = wait for idle + pause queued starts; `0` = legacy immediate enqueue |
| `DEPLOY_GRACEFUL_WAIT_MS` | `600000` (10 min) | Max hold time before forcing release (or `DEPLOY_GRACEFUL_WAIT_SEC`) |

```bash
curl -sS -X POST http://127.0.0.1:4211/api/ops/deploy \
  -H 'content-type: application/json' \
  -d '{"deployment":"deployment-<hash>"}'
```

With `GRACEFUL_RESTART=1`, if agents are running the response is
`state: "waiting_for_idle"`: in-flight runs continue, **queued runs are paused**,
and no request file is written yet. Poll:

```bash
curl -sS http://127.0.0.1:4211/api/ops/restart-status
# { "canRestart": true|false, "runningCount": N, "remainingMs": ..., "deploy": {...} }
```

When `canRestart` becomes true, the last run finishes, **or the wait deadline
expires**, the held deploy is released into `deploy-requests/` for deploy-agent.
After restart, queued runs resume via `recoverQueuedRuns`.

Skip wait for one request (may interrupt running agents):

```bash
curl -sS -X POST http://127.0.0.1:4211/api/ops/deploy \
  -H 'content-type: application/json' \
  -d '{"deployment":"deployment-<hash>","force":true}'
```

Legacy always-immediate mode: set `GRACEFUL_RESTART=0` in backend `.env`.

Cancel a held deploy and resume queue admission:

```bash
curl -sS -X POST http://127.0.0.1:4211/api/ops/deploy/cancel-hold
```

Or drop a JSON file:

```bash
cat > /Users/gaolei/deployment/web-cursor/deploy-requests/deploy-req-demo.json <<'EOF'
{"requestId":"deploy-req-demo","deployment":"deployment-<hash>"}
EOF
```

Poll status:
```bash
curl -sS http://127.0.0.1:4211/api/ops/deploy/deploy-req-demo
# or: cat /Users/gaolei/deployment/web-cursor/deploy-status/deploy-req-demo.json
```

**Agents must not** run `bin/deploy.sh` synchronously inside a task shell — that kills the gateway mid-command.
