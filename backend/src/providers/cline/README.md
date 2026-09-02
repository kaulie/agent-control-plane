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

One Cline session = one Web Cursor task (`task.agentId` stores the opaque Cline
session id):

- First message → `cline.start(...)` (new session; task bootstrap text is prepended).
- Follow-up message → `cline.send(...)` on the resident session (full conversation memory).
- After a process restart, sessions are not resident, so the next message recreates
  the session and re-injects the bootstrap context (mirrors the cursor adapter's
  resume-fail → recreate behaviour).

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
