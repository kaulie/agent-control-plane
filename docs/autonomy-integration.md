# Autonomy × Web Cursor（控制面）集成契约

| 项 | 值 |
|---|---|
| 状态 | **草稿 v1 — 待 autonomy 方复查**（第 4 节是阻塞级待确认清单） |
| 双方 | 调用方：web-cursor 控制面（agent-control-plane，`:4211`）· 被调方：autonomy runtime（`:4300`） |
| 事实来源 | autonomy `docs/http-api.md` + 对运行中的 `http://127.0.0.1:4300` 实测（下文标「实测」）；控制面实测 `http://127.0.0.1:4211` |
| 目的 | 新建任务扩成**两个入口**：①「本机 agent」（现状，控制面自己跑）②「交给 autonomy」（autonomy 自己跑）。两边只通过 autonomy 的 task id 关联 |

## 0. 背景与边界（先说清，避免重复设计）

- **两个入口互不影响**：老入口（`POST /api/tasks`，控制面网关 + 本机 agent）**一行不改**，行为与今天逐字节一致。新入口只是多一条路径。
- **控制面不落库**：新入口**不写** task 行、不存 autonomy 的 task id、不把 autonomy 的任务混进控制面任务列表 / 看板。任务与对话数据**唯一真源是 autonomy**。
- **控制面只做代理**：前端 → 控制面（`/api/autonomy/*`）→ autonomy（`/api/*`）。控制面不改写、不缓存业务状态（仅短暂可用性缓存）。
- **失败语义**：autonomy 不可达/超时 → 控制面返回 `503` + 原文（**不**静默回落成本机 agent 执行）；`4xx` 的 `message` 原样带出给用户。
- **错误形态**：按 autonomy 既有约定 `{"error": "…"}`（实测 404/400 一致）。

## 1. 端到端数据流

```
创建：前端（创建对话框「交给 autonomy」）→ POST 控制面 /api/autonomy/tasks
      → POST autonomy /api/tasks { description, context_ref: { project } }
      → 202 { task_id, agent_id, status, message_id, queued }  → 前端展示 task_id / agent_id

查看：前端 → GET 控制面 /api/autonomy/tasks            → autonomy GET /api/tasks（列表）
     前端 → GET 控制面 /api/autonomy/tasks/{id}       → autonomy GET /api/tasks/{id}（状态 + plans/steps + project）
     前端 → GET 控制面 /api/autonomy/tasks/{id}/agents/{aid}/events?last_synced_message_seq=N（M2，时间线）

世界解析（autonomy 读控制面）：autonomy context_ref{project} → GET 控制面 /api/projects（+ 仓库，见第 3 节⚠️）
```

## 2. autonomy 需提供 / 确认的接口

> 「状态」列：`已实测` = 我已对着运行中的服务打过；`待确认` = 语义/字段需要他拍板（见对应 ❓）。

### A1. 可用性 / 版本（新入口能不能点）

| 项 | 内容 |
|---|---|
| 调用 | `GET /api/meta`、`GET /health` |
| 实测响应 | `meta`: `{service, version, reason_turns, has_tasks_table, turns}` · `health`: `{status, llm_backend:"cline", llm_model:"deepseek-v4-flash", turns}` |
| 我们的用法 | 新入口不可达就置灰 + 显示原因；页头显示 autonomy 版本与当前 LLM 后端 |
| ❓ | `version` 是部署的 `APP_VERSION`（`go run` 时为 `dev`）对吧？我们只展示、不做判断 |
| 状态 | 已实测 |

### A2. 投递任务指令（新入口唯一的写操作）

| 项 | 内容 |
|---|---|
| 调用 | `POST /api/tasks` |
| 请求（文档） | `{ description, domain?, goal_type?, task_id?, context_ref?: { project } }` |
| 响应 `202` | `{ task_id, agent_id, status: "pending", message_id, queued }` |
| 我们的用法 | **只传** `description` + `context_ref.project`（= 当前 projectId）。不传 `domain` / `goal_type` / `task_id` |
| ❓ | ① **`context_ref.project` 指向未知/读不到的 project**：硬失败（4xx）还是照跑但世界只剩 id？（我们不希望任务静默跑在没有仓库的世界里；若「照跑」，UI 必须显式警告）<br>② 能否**显式**传组织/仓库（注册表读不到时兜底）？字段名？<br>③ 省略 `domain`/`goal_type` 是否 OK（默认取行内已有值）？我们不想猜枚举、猜错就 400<br>④ **同一 `task_id` 再次 POST** 是否＝给同一只 owner agent 追加一条指令、忙则排队？（M2「继续对话」要用）<br>⑤ `queued` 是否**含**正在跑的那条（文档说含）<br>⑥ 响应能否顺带回 **`context_ref` 的解析结果**（project 名 / organization / 仓库）？这样创建完立刻能显示「这条任务的世界」，不必再查一次详情 |
| 状态 | 契约已实测（字段名来自其文档的请求样例） |

### A3. 任务列表（控制面「Autonomy 任务」页）

| 项 | 内容 |
|---|---|
| 调用 | `GET /api/tasks` |
| 实测响应 | `{ "tasks": [ { id, description, status, turns, last_at } ] }` |
| ❓ | ① **能否按 project 过滤**（`?project_id=project-xxxx`）？实测 `GET /api/tasks?project_id=project-59c41b54` → `200 {"tasks":[]}`，但库里为空，**无法判断过滤是否真的生效**。没有过滤就只能拉全量再逐条查详情（N+1）<br>② 每行能否带 **`project_id` / `agent_id` / `updated_at`**？（列表要显示所属项目、要能直接跳到 agent 事件流）<br>③ 分页/上限？任务多了会不会一次全返回 |
| 状态 | 已实测（基础字段）；❓待确认 |

### A4. 任务详情 / 进展

| 项 | 内容 |
|---|---|
| 调用 | `GET /api/tasks/{task_id}` |
| 文档字段 | `task_id / description / domain / status / error / goal_type / context_ref / agent_id / created_at / updated_at`，加 `project{id,name,description,domain,git_repo_url,organization{id,name}}`、`plans[].steps[]` |
| 实测 | 未知 id → `404 {"error":"task not found"}` |
| ❓ | ① `status` 七态（`running/pending/completed/unverified/blocked/need_input/error` + `stopped`）**稳定可依赖**吗？我们**照实展示**，不自己翻译成「成功/失败」<br>② `plans[].steps[].status`（`pending` / `ok` / `failed`）枚举会不会扩？（要映射图标/配色）<br>③ `updated_at` 是否随每次运行推进刷新？（用来显示「多久没动了」） |
| 状态 | 已实测（404 形态）；❓待确认 |

### A5. Agent 工作状态

| 项 | 内容 |
|---|---|
| 调用 | `GET /api/tasks/{task_id}/agents/{agent_id}` |
| 响应 | `{ working, agent_run_id?, turn_id? }`；实测未知 agent → `404 {"error":"agent not found"}` |
| ❓ | `agent_run_id` 在流式中段可能为空（其文档提到），此时我们应改为看 `turn_id` 判「在不在动」——请给一个推荐口径 |
| 状态 | 已实测 |

### A6. 增量对话流（M2：映射到控制面时间线）

| 项 | 内容 |
|---|---|
| 调用 | `GET /api/tasks/{task_id}/agents/{agent_id}/events?last_synced_message_seq=N` |
| 响应 | `{ task_id, agent_id, events: [{ message_seq, turn_id, turn_seq, cycle, role, content, run_id, status, created_at }], last_message_seq, next_poll_after_seq }` |
| ❓ | ① `role` 的**完整枚举**（`thinking` / `tool` / `assistant` / `user` / `system`？）——要一一映射成时间线行类型<br>② 工具调用的 `content` 是**全量**入参/结果还是截断？截断规则（按 rune？多长？）<br>③ `message_seq` **跨重启单调**、可当断点续传游标吗？从 `0` 开始是否给全量历史（保留期/裁剪策略）<br>④ ⚠️ **实测异常**：`GET /api/tasks/task-1/agents/10001/events?last_synced_message_seq=0`（**不存在的 task**）返回 `200 {events:[], …}`，而同 task 的 `GET …/agents/10001` 是 `404`。建议 events 对未知 task 也返回 `404`，否则页面会把「id 打错」显示成「没有事件」 |
| 状态 | 已实测（含上述异常）；❓待确认 |

### A7. 停止（M2）

| 项 | 内容 |
|---|---|
| 调用 | `POST /api/tasks/{task_id}/stop` |
| 响应 | `200 {task_id, status:"stopped"}` · `404` 没有这条 task · `409` task 不在运行中（均按文档） |
| ❓ | `409` 的判定窗口；stop 时**排队中的指令**是否一起丢弃（UI 要写清后果） |
| 状态 | 待确认（未实测，避免在真环境造任务） |

### A8.（M3，可选）广播

| 项 | 内容 |
|---|---|
| 调用 | `POST /api/broadcast`，`{ content, project_id }` 或 `{ content, all_projects }`（二者二选一，都不给或 `content` 空 → `400`） |
| 响应 | `200 { scope, targets, delivered, skipped, failed, deliveries[] }` |
| 用途 | 后续「给某个 project 下的所有 agent 发一句话」 |
| 状态 | 待确认（M3 再说） |

## 3. 控制面提供给 autonomy 的（也请一起复查）

| 接口 | 实际返回 | 备注 |
|---|---|---|
| `GET /api/projects` | `[{ projectId, name, department?: { departmentId, departmentName } }]` | autonomy 的 `PROJECTS_API_URL` 默认指 `http://127.0.0.1:4211` |
| `GET /api/tasks/{taskId}` | `taskId, projectId, title, status, description, goal, provider, model, agentId, workspace, prUrl, lastUserInputAt, taskType, createdAt` | `context_ref: { task }` 解析用（autonomy 文档提到用平台 task 注册表） |
| `GET /api/projects/{projectId}/service-repos` | `{ projectId, repos: { available, orgId, orgName, items: [{ name, namespace, gitRepoUrl, description, … }] } }` | **按项目查仓库的现成接口**（控制面内部按 `department.departmentId` 去服务中心查） |

### ⚠️ 阻塞级错配：**仓库地址从哪来**

autonomy `docs/http-api.md` 写的是「平台的 **project 注册表**提供 project 的名字、**仓库**与所属部门」，但控制面的
`GET /api/projects` **已经不返回仓库地址**了：项目级 `gitRepoUrl` 字段已从产品里删除（接口不返回、UI 不展示），
仓库的唯一真源是**服务中心** `GET /v1/orgs/{orgId}/services`（按 `department.departmentId` 查）。

所以请确认 autonomy 取仓库的路径，二选一（或告诉我第三种）：

1. autonomy 自己拿 `department.departmentId` 去查服务中心；或
2. autonomy 改成调控制面的 **`GET /api/projects/{projectId}/service-repos`**（推荐：它已经把「项目 → 组织 → 服务中心」这层收口好了，且与老入口注入给 agent 的仓库清单**同一真源**，两边才可能拿到同一个仓库）。

> 这条直接决定**新入口建的任务能不能拿到正确的仓库**，属于阻塞级。

## 4. 需要 autonomy 方明确答复的阻塞级问题（5 条）

| # | 问题 | 影响 |
|---|---|---|
| 1 | `context_ref.project` 指向未知 project 时的行为（硬失败 / 静默照跑） | 决定新入口是否可能「任务跑在一个没有仓库的世界里」而没人发现 |
| 2 | `GET /api/tasks` 能否**按 project 过滤** + 每行是否带 `project_id` / `agent_id` / `updated_at` | 决定控制面「Autonomy 任务」页要不要 N+1 查询、能不能按项目分组 |
| 3 | **仓库地址到底从哪来**（见第 3 节 ⚠️） | 决定新入口的任务能否拿到正确仓库（与老入口同一真源） |
| 4 | `events[].role` / `plans[].steps[].status` 的枚举**冻结程度** | 决定 UI 图标/配色映射是否会被上游扩枚举打破 |
| 5 | `message_seq` 是否**跨重启单调** + 历史保留期 | 决定时间线能否断点续传、翻历史 |

## 5. 验收方式（他实现完，互通时逐条跑）

```bash
# A1 可用性
curl -s http://127.0.0.1:4300/api/meta ; curl -s http://127.0.0.1:4300/health

# A2 投递（用控制面真实 project）
curl -s -X POST http://127.0.0.1:4300/api/tasks \
  -H 'content-type: application/json' \
  -d '{"description":"打印一行 hello 并结束","context_ref":{"project":"project-59c41b54"}}'
# 期望：202 {"task_id":"task-…","agent_id":<int>,"status":"pending","message_id":<int>,"queued":<int>}

# A3 列表（含我们最想要的过滤）
curl -s 'http://127.0.0.1:4300/api/tasks?project_id=project-59c41b54'
# 期望：只含该 project 的任务；每行建议带 project_id / agent_id / updated_at

# A4/A5 详情与 agent 状态（用上一步返回的 id/agent_id）
curl -s http://127.0.0.1:4300/api/tasks/<task_id>
curl -s http://127.0.0.1:4300/api/tasks/<task_id>/agents/<agent_id>
# 期望：详情 200；未知 id 一律 404（含 events，见 A6④）

# A6 增量流（断点续传：游标 = 上一条的 message_seq）
curl -s 'http://127.0.0.1:4300/api/tasks/<task_id>/agents/<agent_id>/events?last_synced_message_seq=0'
curl -s 'http://127.0.0.1:4300/api/tasks/<task_id>/agents/<agent_id>/events?last_synced_message_seq=<last_message_seq>'
# 期望：第二次只返回新增；未知 task → 404

# A7 停止
curl -s -X POST http://127.0.0.1:4300/api/tasks/<task_id>/stop
# 期望：200 {task_id,status:"stopped"}；再停一次 → 409
```

控制面侧对应的代理（本次实现，M1）与断言：

| 控制面接口 | 转发到 | 附加断言 |
|---|---|---|
| `POST /api/autonomy/tasks` | `POST /api/tasks` | autonomy 不可达 → `503`；**数据库无新增行** |
| `GET /api/autonomy/meta` | `GET /api/meta` | 不可达 → `200 {available:false, error}`（不 500） |
| `GET /api/autonomy/tasks` | `GET /api/tasks` | 同上，透传 |
| `GET /api/autonomy/tasks/{id}` | `GET /api/tasks/{id}` | 404 原样透传 |

> 「**数据库无新增行**」是这次设计的硬约束：新入口不落库（不写 task/run/event），所以测试会显式断言控制面 SQLite 计数不变。

## 6. 范围与后续

- **本契约覆盖**：M1 = 新入口创建 + 列表 + 详情（可用性/状态/计划）。控制面侧只做代理，前端只做查询。
- **M2（下一份）**：时间线（A6 映射）、继续对话（A2④）、停止（A7）。
- **M3（可选）**：广播（A8）、把 evaluation 侧的对比页串起来。
- **不做**：控制面落库、把 autonomy 任务混进控制面任务列表/看板、双建「对照任务」（已明确砍掉）。

## 7. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-09-20 | 初稿：A1–A8 接口需求 + 控制面提供的接口 + 5 条阻塞级问题；对 `:4300` 实测标注 |
