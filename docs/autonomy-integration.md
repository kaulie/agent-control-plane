# Autonomy × Web Cursor（控制面）集成契约

| 项 | 值 |
|---|---|
| 状态 | **v1.4 — 待 autonomy 方复查**（第 4 节只剩 1 条：A6.1 的事件模型要求；未知 project=硬失败、列表过滤、游标单调/永久保留与**游标作用域（A6.2：两边各自独立、不对齐编号）**均已确认） |
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
| ✅ 已确认（2026-09-21） | **`context_ref.project` 指向未知 project → 硬失败**：返回 4xx + `{"error": "…"}`，**不创建任何 task 行**（不要「照跑但世界只剩 id」）。控制面把这段原文直接显示给用户 —— 这正是我们「任务不许跑在一个没有仓库的世界里」的保证。 |
| ❓ | ① 能否**显式**传组织/仓库（注册表读不到时兜底）？字段名？<br>② 省略 `domain`/`goal_type` 是否 OK（默认取行内已有值）？我们不想猜枚举、猜错就 400<br>③ **同一 `task_id` 再次 POST** 是否＝给同一只 owner agent 追加一条指令、忙则排队？（M2「继续对话」要用）<br>④ `queued` 是否**含**正在跑的那条（文档说含）<br>⑤ 响应能否顺带回 **`context_ref` 的解析结果**（project 名 / organization / 仓库）？这样创建完立刻能显示「这条任务的世界」，不必再查一次详情 |
| 状态 | 未知识别/未知 project 已确认（硬失败）；其余 ❓ 待回 |

### A3. 任务列表（控制面「Autonomy 任务」页）

| 项 | 内容 |
|---|---|
| 调用 | `GET /api/tasks?project_id=<id>`（省略 `project_id` = 全部） |
| 响应 | `{ "tasks": [ { id, description, status, turns, last_at, project_id, agent_id, updated_at } ] }` |
| ✅ 已确认（2026-09-21） | **① 支持按 project 过滤**：`?project_id=project-xxxx` 只返回该 project 的任务。<br>**② 每行带 `project_id` / `agent_id` / `updated_at`** —— 控制面列表要显示所属项目、要能直接跳到该 agent 的详情/事件流，有这两个字段就免掉 N+1 查询。 |
| 我们依赖的语义 | `project_id` 省略 → 全部；**未知 `project_id` → `200` + 空数组**（不要 404/500）；`updated_at` 随每次运行推进刷新（列表排序 / 「多久没动」）；`agent_id` 用来拼 `/api/tasks/{id}/agents/{agent_id}/events` |
| 待确认（非阻塞） | 分页 / 上限：任务变多会不会一次全返回？（量级不大可以不分页，我们照显） |
| 状态 | ✅ 支持已确认；分页待确认 |

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
| ✅ 已确认（2026-09-21） | **`message_seq` 跨重启单调**（可当断点续传游标，重启后继续用不跳号）；**历史保留期 = 永久**（不做裁剪 / TTL，从 `0` 拉全量没问题）。→ 时间线可以完整翻历史。 |
| 待确认（非阻塞） | events 对**未知 task** 目前返回 `200 {events:[]}`（同 task 的 `/agents/{aid}` 是 `404`）→ 建议也改 `404`，否则页面会把「id 打错」显示成「没有事件」。<br>`role` 完整枚举与工具事件的字段要求见 **A6.1**（下面）——这是要与控制面现有时间线长得一致的关键。 |
| 状态 | 游标单调性 / 保留期已确认；role 枚举与工具字段见 A6.1 |

#### A6.1 要与控制面现有时间线「长得一致」，需要支持的事件模型（要求）

控制面时间线是按 **run** 分组渲染的（一次用户输入 → agent 干完 = 1 run），每行由事件类型决定：
`user_message` / `run_started` / `thinking` / `agent_response` / `tool_call_started` + `tool_result`（我们按工具
细分 `file_read` / `file_edit` / `terminal` / `search`）/ `usage` / `run_completed` / `run_cancelled` /
`run_error` / `status` / `plan_draft` / `plan_question_batch` / `agent_decision`。

> 字段名可以按他的模型定（我们只加一层适配），但**语义要能表达出来**；下表写的是「我们要渲染成什么，需要什么」。

| 我们要渲染的行 | 需要 autonomy 在 `events[]` 里给 | 备注 |
|---|---|---|
| 指令 / 用户消息 | `role: "user"` + `content` + **来源**（`user` / `agent` / `runtime`） | 我们区分「人打的」与「系统投递的需求」（现在用 `deliveredBySystem` + `kind:"task_intent"` 渲染成 ⚙️ 卡片）；inbox 的三类来源正好对上 |
| 一次运行开始 | turn/run 起点（或首个事件的 `turn_id` 变化）+ `model`、`cwd`（可选） | 我们显示「模型 · 工作目录」 |
| 思考 | `role: "thinking"` + `content` | 折叠显示、可展开 |
| 助手输出 | `role: "assistant"` + `content` | 与 thinking 分开，这是「答复」 |
| 工具调用 | `role: "tool"` + **工具名** + **入参对象** + **调用 id** | 我们按入参里的 `path` / `pattern` / `file_path` 取摘要，否则整段 JSON 截 160 字符 |
| 工具结果 | 与调用**配对**（同调用 id）的结果事件 + 结构 `{status, value:{stdout 或 content 或 output 或 matches}, error}`（或等价纯文本） | 我们显示 stdout/content/output（截 600 字符）、`matches` 计数、`error: …` |
| token 用量 | 每条消息或每个 turn 的 `{input, output, cacheRead?, cacheWrite?, total}` | 我们显示 `N tokens`；**可选**，缺了只是少一行 |
| 中间态 | `role: "status"` + `content`（如 re-plan、重试、等输入） | 渲染成一条状态行 |
| 计划 / 决策 | `role: "plan"` / `"decision"` + `decision.type`（`plan` / `done` / `blocked` / `need_input`） + `reason` +（可选）计划摘要 | 对应我们的 `agent_decision`（显示类型 + reason） |
| re-plan 轮次 | `cycle` 每次 +1 时给一条事件（或让我们按 `cycle` 变化插一行） | 要能看出「第 3 轮重新规划」 |

**生命周期（最关键的一条）**：控制面按 run 分组，并且**要求「这一轮跑完了」有明确落点**（耗时、成功/失败）。请明确三点：

1. **一个 `turn` 是否 = 我们的一次 run**（一条 inbox 消息 → 处理完）？是 → 我们按 `turn_id` 分组、用该 turn 的结束事件收尾；不是 → 请给另一个「这次运行结束」的标记。
2. **每次运行的终态怎么给**：`running/unverified/blocked/need_input/error/stopped` 是 **task 级**状态，我们需要**每轮**也能收尾。建议每条消息带 `status`（`running|done|error`），turn 最后一条标 `done`；或用 `plans[].steps[]` 收尾。
3. `blocked` / `need_input` 之后用户再发指令 → 同一个 `turn_id` 继续，还是新 turn？（决定时间线是「继续这一段」还是「新开一段」。）

**做不成的降级代价**（便于取舍，都不影响 M1）：

| 缺什么 | 我们会退化成 |
|---|---|
| 没有工具入参 / 结果结构 | 只显示工具名，信息量掉一半 |
| 调用与结果不能配对 | 各占一行、无法折叠 |
| 没有每轮终态 | 时间线无法显示「耗时 / 是否跑完」，只能按 `message_seq` 平铺 |
| 没有 `cycle` 事件 | 看不出第几轮 re-plan |

#### A6.2 游标作用域（已确认：两边各自独立，**不需要对齐编号**）

| 侧 | 游标 | 语义（实测 / 代码） |
|---|---|---|
| 控制面 | `events.seq` | 单库**一个** `AUTOINCREMENT` 序列（`backend/src/store/db.ts`：`seq INTEGER PRIMARY KEY AUTOINCREMENT`；`sqlite_sequence` 里只有 `events` 一张表）。按某个 task 看，它只是这个序列里的**一段稀疏切片，且与其它 task 交错**（实测：`MIN=1 / MAX=509266 / COUNT=509266 / 105 个 task`；本任务 seq `503784→509266` 只有 1050 条；同时在跑的另一个任务 `506051→509269` 正好嵌在里面）。接口游标就是它：`GET /api/tasks/{id}/events?after=<seq>`（`?before=<seq>` 翻历史；`eventId`（`evt-…`）是随机唯一 id，**无序**，只用于去重）。 |
| autonomy | `message_seq` | `llm_messages.id`，其库内的全局单调 id（其文档：对外游标用全局 id，而不是 run 内会重置的 seq） |

**两边不共用、不比较**：前端每个视图只对**一边**拉取（本机任务吃控制面 `events`，autonomy 任务走代理吃 autonomy `events`），控制面把 `last_synced_message_seq` **原样透传**；不存在把两个来源的数字放在一起比大小的代码路径。

**因此明确不需要对齐编号空间** —— 不需要（也不建议）让 autonomy 的第一个 id 从「大于控制面当前最大 seq」开始：

1. 两条序列**各自继续自增**，重叠/交错是必然的（我们这边 105 个 task 本来就互相交错）→「先大于」只在一瞬间成立，任何「谁大谁新」的跨系统假设都会立刻失效；
2. 它是**脆弱的手工状态**：换库 / 回滚 / 新环境就丢，还会把 id 无意义地抬高；
3. 将来若真要**在同一视图里合并**两个来源的事件，正确做法是复合键 **`(source, seq)`**（或直接比时间戳），而不是对齐裸数字。

**我们真正需要的游标保证（已确认）**：① 全局单调；② **跨重启单调**（重启后不跳号、可继续用同一个游标）；③ **历史保留期 = 永久**（从 `0` 拉全量可行）。

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

### ✅ 已确认：仓库由 autonomy **自行推导**（本项已关闭）

仓库不需要控制面额外提供：**autonomy 自己推导「项目 → 仓库」**，控制面不新增/不改动任何接口。推导链路：

```
project（context_ref.project）
  → 控制面 GET /api/projects 取 department.departmentId（组织 id）
  → 服务中心 GET /v1/orgs/{orgId}/services 取该组织登记的服务（含 gitRepoUrl）
```

控制面 `GET /api/projects` 返回 `[{ projectId, name, department?: { departmentId, departmentName } }]` ——
**不含仓库地址**（项目级 `gitRepoUrl` 字段已从产品里删除）；仓库的唯一真源是**服务中心**，
与老入口注入给 agent 的仓库清单是同一处，所以两个入口拿到的仓库一致。

> 与老入口一致的边界：**没设「所属部门」的 project 推导不出仓库**（服务清单按组织查；实测 `project-default` 就没有 `department`）。此时两个入口都拿不到仓库 —— 行为一致，不是新入口的缺陷。

（仅供参考，当前不需要）控制面也有一条现成的 `GET /api/projects/{projectId}/service-repos`（内部就是「项目 → 组织 → 服务中心」）；
若以后想省掉自己拼链路，可以改用它。

## 4. 待 autonomy 方确认（1 条）

| # | 事项 | 影响 |
|---|---|---|
| 1 | **A6.1 的事件模型要求**（`role` 完整枚举 + 工具调用的入参/结果 + 每轮终态 + `cycle`）能否照此支持 | 决定 autonomy 的任务能不能在控制面现有时间线里**长得和本机 agent 一致**（M2），以及要多少降级 |

> 已关闭：~~仓库地址从哪来~~（autonomy 自行推导，第 3 节 ✅）· ~~列表按 project 过滤 + 行字段~~（已确认支持，A3 ✅）· ~~未知 project 的行为~~（**硬失败**，A2 ✅）· ~~`message_seq` 单调性 / 历史保留期~~（**跨重启单调 + 永久保留**，A6 ✅）。 · ~~两个来源的游标要不要对齐编号~~（**不需要**：各自独立、不共用不比较，见 A6.2 ✅）

## 5. 验收方式（他实现完，互通时逐条跑）

```bash
# A1 可用性
curl -s http://127.0.0.1:4300/api/meta ; curl -s http://127.0.0.1:4300/health

# A2 投递（用控制面真实 project）
curl -s -X POST http://127.0.0.1:4300/api/tasks \
  -H 'content-type: application/json' \
  -d '{"description":"打印一行 hello 并结束","context_ref":{"project":"project-59c41b54"}}'
# 期望：202 {"task_id":"task-…","agent_id":<int>,"status":"pending","message_id":<int>,"queued":<int>}

# A3 列表（按 project 过滤 —— 已确认支持）
curl -s 'http://127.0.0.1:4300/api/tasks?project_id=project-59c41b54'   # 只含该 project
curl -s 'http://127.0.0.1:4300/api/tasks'                                # 省略 = 全部
curl -s 'http://127.0.0.1:4300/api/tasks?project_id=project-nope'        # 未知 → 200 + 空数组
# 期望：每行 id/description/status/turns/last_at + project_id/agent_id/updated_at

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
| v1.1 | 2026-09-21 | **仓库来源已确认**：由 autonomy **自行推导「项目 → 仓库」**（project → department.departmentId → 服务中心 组织服务清单），控制面无需新增接口；⚠️ 阻塞项关闭，阻塞级问题 5 → 4 条 |
| v1.2 | 2026-09-21 | **列表已确认**：`GET /api/tasks` 支持按 `project_id` 过滤，每行带 `project_id` / `agent_id` / `updated_at`（A3 ✅）；阻塞级问题 4 → 3 条 |
| v1.3 | 2026-09-21 | 三个答复落纸：**未知 project → 硬失败**（A2 ✅）· **`message_seq` 跨重启单调 + 历史永久保留**（A6 ✅）· 新增 **A6.1 事件模型要求**（要与我们现有时间线一致所需的 `role` 枚举 / 工具入参结果 / 每轮终态 / `cycle`，含降级代价）→ 第 4 节 3 条收敛为 1 条 |
| v1.4 | 2026-09-21 | 新增 **A6.2 游标作用域**：控制面 `events.seq` 是单库全局 `AUTOINCREMENT`（按 task 稀疏、与其它 task 交错，实测 min=1/max=509266/105 tasks），autonomy `message_seq` 是它库内的全局单调 id；**两边各自独立、不共用不比较，因此不需要对齐编号空间**（并写明若将来合并展示要用 `(source, seq)` 复合键；需要的保证只有：全局单调 / 跨重启单调 / 永久保留） |
