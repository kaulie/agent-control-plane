# Agent Provider (Adapter Layer)

`AgentProvider` is the **swappable agent runtime adapter**. Gateway, HTTP, WebSocket, and the DB depend only on this interface — never on a concrete SDK.

## Contract

See [`types.ts`](./types.ts):

| Method | Role |
|--------|------|
| `verifyAuth` | Startup / health auth check |
| `listModels` / `resolveModel` | Model catalog and default |
| `run` | Execute one turn; stream unified `AgentEvent`s via `onEvent` |
| `cancel` | Stop an in-flight run by `runId` |
| `reconcileAfterRestart?` | Clear orphaned underlying runs after process crash |
| `dispose?` | Release long-lived resources on shutdown |

`RunInput.agentId` is an opaque **session handle** for the adapter (resume / bind).  
`RunInput.mode` (`agent` \| `plan`) is a **product conversation mode**; each adapter maps it to its runtime if supported.

## Layout

```
providers/
  types.ts              # AgentProvider contract
  create-provider.ts    # Factory (register new adapters here)
  cursor/               # Cursor SDK implementation (only place that imports @cursor/sdk)
    index.ts
    mapper.ts           # SDK messages → AgentEvent
```

## Adding another runtime

1. Create `providers/<name>/` with a class `implements AgentProvider`.
2. Map that runtime’s stream into the same `AgentEvent` shapes the UI already understands.
3. Register the name in [`create-provider.ts`](./create-provider.ts).
4. Wire startup (env / config) to pass `name` into `createProvider`.

No gateway or frontend changes should be required if events and `RunResultData` stay compatible.
