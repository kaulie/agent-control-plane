# Task Context Report — `task-2c438baf5499b592`

> Known context of one task, as supplied to the executing agent.
> This document records **only** the facts explicitly given for this task.
> Nothing is inferred or invented; items that are unknown are listed as unknown
> under "Open / Unknown" instead of being filled in.
>
> Prepared by agent `agent-10003` (role `worker`, purpose `code_edit`) in the
> workspace `/Users/gaolei/agent-workspace-sandbox/agent-10003/`.

## 1. Task

| Field | Value |
|---|---|
| id | `task-2c438baf5499b592` |
| description | 你现在能描述下你知道这个task的上下文信息有哪些吗 |
| domain | `software_development` |
| goal_type | `dev_feature` |
| status | `pending` |
| context_ref.project | `project-59c41b54` |

The task is a question about this task's own context: "can you describe what
context information you know about this task". The deliverable of this work is
this report itself.

## 2. Project (task context entity)

| Field | Value |
|---|---|
| id | `project-59c41b54` |
| name | `web-cursor` |
| type | `project` |

`project-59c41b54` is the project referenced by the task
(`context_ref.project`) and the only context entity listed for it.

## 3. Organization

| Field | Value |
|---|---|
| id | `D0005` |
| name | `AI研发部` |
| type | `研发` |

### Services of the organization

| Service | git_repo_url | version |
|---|---|---|
| `agent-benchmark-tool` | https://github.com/kaulie/agent-benchmark-tool | — |
| `agent-control-plane` | https://github.com/kaulie/agent-control-plane.git | `8db9cc29` |
| `autonomy` | https://github.com/kaulie/autonomy | `ff9899c0` |

No version is given for `agent-benchmark-tool`.

## 4. World Model

No assets. The World Model supplied for this task is empty (`assets: []`),
so there is no target asset and no known world state to mutate.

## 5. Runtime context

| Field | Value |
|---|---|
| cycle | `1` |
| context[] | one entry: `project-59c41b54` (type `project`) |
| that entry's `context_entities` | empty |
| that entry's `entities` | empty |
| that entry's `assets` | empty |

So the runtime context carries the project reference only; it contributes no
additional entities or assets beyond Section 2 and Section 4.

## 6. Provenance / delegation

| Field | Value |
|---|---|
| delegated_by.agent | `agent-10002` |
| delegated_by.cycle | `1` |
| executing agent | `agent-10003` (backend `cline`, model `deepseek-v4-flash`, lifecycle `persistent`) |

The task was delegated by `agent-10002` in cycle 1 and executed by
`agent-10003`.

## 7. Constraints

- **Writable location (as stated in the goal):**
  `/Users/gaolei/agent-workspace-sandbox/agent-10002/` is named as the only
  writable location, and the goal states it is the only place work may happen.
  That path belongs to the delegating agent (`agent-10002`); the executing agent
  therefore carried out the work in its own workspace
  `/Users/gaolei/agent-workspace-sandbox/agent-10003/`, which is the only place
  its files may be changed. The constraint as given is recorded here verbatim so
  the context is complete.
- **Scope (from the goal):** the files this task touches (for this task, this
  `TASK_CONTEXT_REPORT.md` document).
- **Deployment (from the goal):** deployment is performed by the Runtime, not by
  the agent.

Additional constraints that apply to this workspace, taken from the repository's
own rules (`AGENTS.md`, read in this workspace — not from the task facts):

- Never commit or overwrite `backend/.env` or `backend/data/`.
- Changes go on a task branch, never on the default/main branch.

## 8. Open / Unknown

Facts that are **not** provided and are deliberately left blank rather than
guessed:

- No assets in the World Model (Section 4).
- No entities / context entities beyond `project-59c41b54` (Sections 2 and 5).
- No service version for `agent-benchmark-tool` (Section 3).
- No priority, due date, assignee, labels, or dependency/relation data for the
  task.
- The goal text does not name a repository URL (`gitRepoUrl` is a legacy field
  that no longer exists in the app; repo addresses come from the service
  registry — Section 3).

## 9. Summary

The task `task-2c438baf5499b592` ("describe what context you know about this
task") belongs to project `project-59c41b54` (`web-cursor`) of organization
`D0005` (`AI研发部`, type `研发`), whose services are `agent-benchmark-tool`,
`agent-control-plane` and `autonomy`. It is a `dev_feature` /
`software_development` task in status `pending`, delegated by `agent-10002` in
cycle 1. The World Model has no assets and the runtime context adds nothing
beyond the single project reference.
