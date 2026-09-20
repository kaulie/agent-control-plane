# Cline Provider

`ClineProvider` implements the `AgentProvider` contract (see `../types.ts`) using the
Cline SDK (`@cline/sdk`). It drives an in-process local Cline agent; by default it is
configured for **DeepSeek** via `DEEPSEEK_API_KEY`.

## Model

- `providerId`: `CLINE_PROVIDER_ID` (default `deepseek`).
- Model: `CLINE_MODEL`, otherwise the first model from the DeepSeek catalog
  (`deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`).
- Key: `DEEPSEEK_API_KEY`. Optional `CLINE_BASE_URL` for OpenAI-compatible providers.
- Optional `CLINE_SYSTEM_PROMPT` override.

## Session mapping

One Cline session = one Web Cursor task (`task.agentId` stores the **current**
opaque Cline session id):

- First message → `cline.start(...)` (new session; task bootstrap text is prepended).
  For a brand-new task the session id is **not** generated here: the gateway passes
  `RunInput.preallocatedAgentId` (the id it allocated at task creation = the agent's
  workspace directory `agent-<agentid>`), and Cline's host accepts a caller-owned
  session id, so the agent id and the workspace stay identical.
- Follow-up message → `cline.send(...)` on the resident session when the product
  mode matches the mode the session was created with.
- Mode change (plan ↔ agent/yolo) → rebuild like the Cline desktop host:
  `readLiveMessages` → `start` with `initialMessages` + new mode + a **new**
  session id (never reused) → `stop` the old session. Conversation context is
  seeded; write tools match the new mode.
- Unusable resident session → same succession path (`reason: session_unusable`)
  when live messages can be read.
- After a process restart, in-memory residency is cleared, so the next message
  recreates a session (bootstrap re-injected when there is no seed).

### Seed contract (why history gets sanitized)

Feed history to a provider and it will hard-reject it if the tool pairing is
broken (`Messages with role 'tool' must be a response to a preceding message
with 'tool_calls'`). Cline records tool results as `role: "user"` messages
(`content: [{ type: "tool_result", tool_use_id }]`), so a naive tail-trim can
start the seed **on a tool result**, and a mid-turn cut can leave a dangling
`tool_use`. Both were seen in production (2026-09-20, two tasks stuck: every
subsequent message failed in <1s because the broken history stayed resident).

So every seeded history (restart resume **and** succession) goes through
`sanitizeSeedHistory()` (`restart-resume.ts`):

- drop `tool_use` / `tool_result` blocks whose counterpart is not in the seed,
- drop messages emptied by that, and drop everything before the first **real
  user turn** (a `tool_result`-only `user` message is not a user turn),

and if the upstream still rejects the seed (`isToolPairingError`), we throw the
seed away and rebuild with a brand-new session id (bootstrap only) instead of
leaving a permanently-400ing session behind.

### Agent succession (transparent lineage)

When the session id changes with inherited history, the provider emits
`agent_succession`. The gateway:

1. Appends the event to the task timeline (visible in the UI).
2. Inserts a row into `agent_successions` (`from_agent_id` → `to_agent_id`,
   modes, `seeded_messages`, reason).

`GET /api/tasks/:taskId/agent-successions` lists the chain. Historical
`events.agent_id` / `runs.agent_id` are **not** rewritten; only
`tasks.agent_id` points at the current session.

## Event mapping

Cline `agent_event` stream → unified `AgentEvent` (see `mapper.ts`):

| Cline event | Unified event |
| --- | --- |
| `content_end` (text) | `agent_response` |
| `content_end` (reasoning) | `thinking` |
| `content_start` (tool) | `tool_call_started` |
| `content_end` (tool) | `file_read` / `file_edit` / `terminal` / `search` / `tool_result` |
| `usage` | `usage` |
| `notice` | `status` |

Tool names are classified heuristically; the cursor adapter's classification rules
are mirrored where the tool names overlap.

## Limitations

- DeepSeek classic models are text-only: image inputs are rejected with a clear error.
- Cost: prefers the SDK-reported `totalCost` (USD → cents); falls back to the bundled
  DeepSeek pricing estimate (`config.ts`).
- `mode: "agent"` maps to Cline `yolo` (autonomous); `mode: "plan"` maps to Cline `plan`.
- Cline `send({ mode })` does **not** rebuild plan-bound tools; mode switches must
  go through the succession path above (same as the VS Code `SdkModeCoordinator`).
