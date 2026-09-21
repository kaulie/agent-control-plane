# Autonomy × Web Cursor（控制面）集成契约

| 项 | 值 |
|---|---|
| 状态 | **v2.0 — 待 autonomy 方复查**（第 4 节只剩 1 条：A6.1 的事件模型要求；未知 project=硬失败、列表过滤、游标单调/永久保留与**游标作用域（A6.2：两边各自独立、不对齐编号）**均已确认） |
| 双方 | 调用方：web-cursor 控制面（agent-control-plane，`:4211`）· 被调方：autonomy runtime（`:4300`） |
| 事实来源 | autonomy `docs/http-api.md` + 对运行中的 `http://127.0.0.1:4300` 实测（下文标「实测」）；控制面实测 `http://127.0.0.1:4211` |
| 目的 | 新建任务时多一条**agent 创建路径**：①由**控制面**创建（现状，本地工作区跑）②由 **autonomy** 创建（它的 runtime 跑）。**任务始终由控制面创建并落库**（谁建的就是谁建的），`agentPath` 只决定 agent 由谁创建；autonomy 执行时我们存下执行方那侧的 `task_id` / `agent_id` 作为两边的对应关系 |

## 0. 背景与边界（先说清，避免重复设计）

- **两个入口互不影响**：老入口（`POST /api/tasks`，控制面网关 + 本机 agent）**一行不改**，行为与今天逐字节一致。新入口只是多一条路径。
- **任务由控制面创建并落库**：走新入口时，控制面先建**自己的** task 行（我们的 task id、项目、类型/目标、description），再把「执行」交给 autonomy（`POST /api/tasks`）。因此任务是一等公民：出现在我们自己的任务列表 / 详情里（`agentPath=autonomy`），失败也留痕。
- **执行数据仍在 autonomy**：它的 runs / 事件 / 对话是那边的真源，**不镜像进我们的库**（不进看板 / 用量 / 统计）；我们只额外存两个 id（`executor_task_id` / `executor_agent_id`）做对应，状态与进展按需代理读取。
- **交接失败不假装成功**：任务已建 → autonomy 拒绝（4xx）或不可达（503）时，任务**保留**、状态标 `error`、原文写进时间线（`executor_failed`），并把它一起返回给前端。**绝不**回落成本机 agent 执行。
- **但界面上是同一个列表**：`agentPath = autonomy` 的任务会并进侧栏那个 Tasks 列表（展示层适配，数据实时来自代理），详情也渲染在同一个主区外壳里 —— 用户看到的是一套任务，只有「agent 由谁创建」这一处不同。**「不落库」是数据层约束，不是「单独开一个页面」的理由**；反过来，界面上合并也**不**意味着控制面存了这些行（见第 5 节测试：每次代理调用都断言库里计数不变）。
- **拿不到就留空**：autonomy 接口暂时给不了的字段（provider、组织、仓库、计划步骤、时间线 / 对话消息、用量…）在界面上**不渲染、不写占位**；等它的接口补齐（M2）再往同一个位置加，版式不变。
- **控制面只做代理**：前端 → 控制面（`/api/autonomy/*`）→ autonomy（`/api/*`）。控制面不改写、不缓存业务状态（仅短暂可用性缓存）。
- **失败语义**：autonomy 不可达/超时 → 控制面返回 `503` + 原文（**不**静默回落成本机 agent 执行）；`4xx` 的 `message` 原样带出给用户。
- **错误形态**：按 autonomy 既有约定 `{"error": "…"}`（实测 404/400 一致）。

## 1. 端到端数据流

```
创建：前端（创建对话框选「由 autonomy 创建 agent」）→ POST 控制面 /api/tasks { description, projectId, agentPath: "autonomy" }
      → 控制面**先落库**（我们的 task id；provider=autonomy；不建本地工作区、不预分配本地 agent）
      → POST autonomy /api/tasks { description, context_ref: { project } }
      → 202 { task_id, agent_id, status, message_id, queued }
      → 记到我们的行上：executor_task_id / executor_agent_id（时间线留一条 `executor_attached`）
      → 201 返回**我们的** task（前端当普通任务展示）
      失败：4xx/503 + 原文；任务保留并标 error（时间线 `executor_failed`）

继续：前端（详情/对账行底部的输入框，同一个 ChatInput）→ POST 控制面 /api/tasks/{我们的 id}/messages { message }
      （对账行——只在 autonomy 那边存在、我们没建过的任务——走 POST /api/autonomy/tasks/{它的 id}/messages；
       除寻址外与下面逐条一致，同样纯代理、我方库一行不写）
      → 控制面先 GET autonomy /api/tasks/{executor_task_id}（确认它真有这条 task）
      → POST autonomy /api/tasks { task_id: <executor_task_id>, description: <那句话> }   ← 追加一条指令（忙则排队）
      → 202 { task_id, agent_id, status, message_id, queued }
      → 202 { executor: true, executorTaskId, messageId, queueAhead, executorStatus } 给前端（本机不跑 run）
      只收文字：带图 → 400 且**不投递**；它不可达/被拒 → 503/4xx + 原文（绝不回落成本机 agent）

查看：前端 → GET 控制面 /api/tasks/{我们的 id}/executor → autonomy GET /api/tasks/{executor_task_id}（状态 + plans/steps + project）
     前端 → GET 控制面 /api/autonomy/tasks            → autonomy GET /api/tasks（列表；对账 + 显示执行方状态）
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
| 我们的用法 | **建任务**时**只传** `description` + `context_ref.project`（= 当前 projectId），不传 `domain` / `goal_type`；**继续对话**（chat 输入）时传 `task_id`（= 我们记下的 `executorTaskId`）+ `description`（那句话），不传 `context_ref`（它按行里已有的上下文走） |
| ✅ 已确认（2026-09-21） | **`context_ref.project` 指向未知 project → 硬失败**：返回 4xx + `{"error": "…"}`，**不创建任何 task 行**（不要「照跑但世界只剩 id」）。控制面把这段原文直接显示给用户 —— 这正是我们「任务不许跑在一个没有仓库的世界里」的保证。 |
| ✅ 已实测（2026-09-21，③） | **同一 `task_id` 再次 POST ＝ 给同一只 owner agent 追加一条指令，忙则排队**（不会被拒）：`202 {task_id, agent_id, status, message_id, queued}`；实测投递后那一轮的 `thinking` 里就引用了我们发的那句话。→ **chat 输入**（控制面详情底部的输入框）就架在它上面，不需要新接口。<br>⚠️ 同一实测也确认了**它的反面**：`task_id` 在它库里**未知**时，这条路会**当成新任务建出来**（接受路径就是创建路径，`src/api_service.go`）。所以控制面**投递前先 `GET /api/tasks/{id}` 确认它真有这条 task**，否则 404 且**不投递**。 |
| ❓ | ① 能否**显式**传组织/仓库（注册表读不到时兜底）？字段名？<br>② 省略 `domain`/`goal_type` 是否 OK（默认取行内已有值）？我们不想猜枚举、猜错就 400<br>④ `queued` 是否**含**正在跑的那条（文档说含）<br>⑤ 响应能否顺带回 **`context_ref` 的解析结果**（project 名 / organization / 仓库）？这样创建完立刻能显示「这条任务的世界」，不必再查一次详情 |
| 状态 | 未知 project（硬失败）、**同一 task 追加指令（③）**已确认；其余 ❓ 待回 |

### A3. 任务列表（控制面侧栏 Tasks 列表里的一行）

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

### A9. 数据落点与粒度（自查用：`reason_turns` / `llm_messages` / `agent_messages` / `llm_events`）

autonomy 的执行数据**不在控制面库里**（我们只有本机的 `runs` / `events`）。去钻它的数据前，先记住两件事：

**① 线上库是 PostgreSQL**（`AUTONOMY_STORE_ENGINE=postgres`；连接串在部署侧 `pg-autonomy.env`，**含口令：不要提交、不要贴群**）。
`~/Projects/autonomy/data/autonomy.db` 那份 SQLite 是**旧库/归档**（内容停在 v1：实测 2 tasks / 338 messages / 12 turns，
而线上 PG 是 5 / 68 / 14），对着它查会得到「这条 task 根本没有数据」的假象。**判据**：`GET /api/meta` 的 `turns`
等于 PG 里 `reason_turns` 的行数（实测 14 = 14）。

**② 四张表的粒度不同，行数天然不相等**（下例为 `task-2c438baf5499b592` 的真实数据）：

| 表 | 一行 = | 该 task 实测 |
|---|---|---|
| `agent_messages` | **任务级对话**：用户指令 / agent 之间的委派 | **2**（`user` 的 `instruction` + `agent-10002` → `agent-10003` 的 `delegation`） |
| `reason_turns` | **一次 LLM 调用**（`mode` / 模型 / 耗时 / 用量 / `run_id`） | **5**（planner 4 + executor 1） |
| `llm_messages` | 那次调用里的**每条消息**：prompt 分段 / `thinking` / `tool` 结果 / 最终 `assistant` | **41**（thinking 17 · tool 14 · assistant 5 · user 4 · agent 1） |
| `llm_events` | 流式 token / 工具事件（就是 A6 的增量流） | **0**（本部署尚未落库 → 所以 `reason_turns.event_count` 全是 0，**不代表没干活**） |

因此 **`llm_messages.turn_id` ↔ `reason_turns.id` 是 N:1**（不是 1:1）：上例 5 个 turn 的消息数分别是
`3 / 29 / 3 / 3 / 3` —— 那 29 条属于**执行 agent**：它一轮里跑了 14 次工具调用，每次「工具结果 + 紧随的 thinking」
各占一条，再加 1 条 `agent` 首帧提示与 1 条 `assistant` 终稿。

**两个容易看岔的字段**：

- `llm_messages.status` 记的是**这条消息流**的终态，不是轮次终态：只有每轮最后那条 `assistant` 是 `finished`，
  其余 `user` / `thinking` / `tool` / `agent` 都是 `running`（按 `status='finished'` 过滤刚好剩 5 条 = 5 个 turn，别误读成「另一套数量」）；
- `agent_messages.kind='instruction'` 的 `status='failed'` **不代表任务失败**（该任务的执行走的是那条 `delegation`），
  任务终态要看 `tasks.status` / `verification`（例：planner 自述 `type:"done"` 但引擎 `verification` 判
  `inconclusive` → 任务落 `unverified`）。

只读自查 SQL（口令从部署侧 env 取，别写进脚本）：

```sql
-- 一次 LLM 调用一行：谁在跑、跑了多少轮
SELECT agent_id, mode, count(*) AS turns, sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok
  FROM reason_turns WHERE task_id = 'task-…' GROUP BY 1, 2 ORDER BY 1;

-- 每个 turn 里的消息构成（这是「41 对 5」的正解）
SELECT turn_id, agent_id, cycle, role, count(*)
  FROM llm_messages WHERE task_id = 'task-…' GROUP BY 1, 2, 3, 4 ORDER BY 1, 4;

-- 真·错配的判据（都应为 0：没有孤儿消息、没有空轮次）
SELECT count(*) FROM llm_messages m WHERE m.task_id = 'task-…'
   AND NOT EXISTS (SELECT 1 FROM reason_turns r WHERE r.id = m.turn_id);
```

### A9.1 谁干的活：`execution_step.agent_id` 是**委托方**，worker **每次委托都新建**

展示 / 统计「这条 task 经过哪些 agent」时，**不要**用 `execution_step.agent_id` —— 它记的是**发起这一步的 planner**
（实测这条 task 的 4 个 `code_edit` step 全是 `10002`）。真正干活的 worker 要顺着这条链找：

```
execution_step ──(execution_step_interaction.reason_turn_id)──▶ reason_turns.agent_id   ← worker
              └── agent_messages(kind='delegation', sender_id='agent-<委托方>')         ← 同一件事的对话行
```

**worker 不复用**：`code_edit` 调 `runtime.AcquireAgent({Purpose, Backend, TaskID})`（**不传 workspace**，worker 用
自己的沙箱），而 `Runtime.AcquireAgent` 的第一行就是 `agents.NewAgent()` —— **每次委托新建一只**（`Role=worker`、
`Lifecycle=persistent`、`CurrentTask=` 委托方的 task id）。没有任何「找同 task 的空闲 worker 复用」的分支；
`agent_resume.go` 里的复用只针对 **planner**（`ForTask` → `Adopt`(`tasks.agent_id`) → `Create`），
所以 **planner 跨指令一直是同一只、worker 是一次委托一只（留着、可 resume，但不被下一次委托挑走）**。

实测（`task-2c438baf5499b592`：三批指令 → 三只 worker，planner 始终 `10002`）：

| 指令 | planner cycle | `code_edit` 步骤 | worker（`reason_turns.agent_id`） |
|---|---|---|---|
| 10:38「描述下你知道的上下文」 | 1→4 | step 1 `report` ok | **10003**（turn 4） |
| 13:57「挪数据库相关代码」 | 1→3 | step 5 `refactor` ok | **10007**（turn 16） |
| 15:23「改 pullrequest capability」 | 1→4 | step 8 `report` **failed 0ms**（World Model asset 缺失 → 没建 agent）→ step 9 ok | **10008**（turn 21） |

> 所以「最新一轮用的 agent 和上一轮不一样」是**设计如此**（One Owner, Many Specialists：planner 只按 capability
> 派活，背后有没有 worker、用哪只由 runtime 决定），不是串了别的任务 —— 三只 worker 的 `agents.current_task_id`
> 都写着这条 task 的 id。

### A9.2 `pending` 是什么（含「自部署把观察者杀掉」这个坑）

`GET /api/tasks/{id}` 的 plan 里 `steps[].status` 只有三种来路（`src/api_service.go` → `planStepProgress`）：
**计划里有这一步 → 默认 `pending`**，只有存在对应的 `execution_step` 行时才被盖成 `ok` / `failed`。
所以 **`pending` = 「计划了、没有执行记录」**，**不是「正在跑」**。

而 `execution_step` 行是在 `action.Execute()` **返回之后**才写的（`runtime.go` → `recordStep`），
`CapabilityAction …` 日志也是 `cap.Run()` **返回之后**才打（`action.go`）—— 因此
**执行中被打断 = 既没有日志、也没有行**，看起来就永远停在 `pending`。

实测（`task-2c438baf5499b592` 最新 plan 14 = `service.deploy` + `deployment.monitor{watch:true}`）：

1. `15:41:02.94` planner 决策出这份 plan（`reason` 还是「cycle 3 的 done 被验证拒了」）；
2. `15:41:03.27→.28` `service.deploy {branch: main, service: autonomy}` 返回 **ok** —— 它**只触发、不等**：
   `{pipeline_id: pipeline-e5f5c7db, poll: /api/pipelines/pipeline-e5f5c7db, state: queued}`；
3. `deployment.monitor` 带着绑定 `deployment ← step:deploy.output.pipeline_id` 与 **`watch=true`** 开始轮询这条流水线
   （客户端 20s 超时，流水线约 12s 完成 → 正常应在 ~15:41:15 返回并落行）；
4. **这条流水线部署的正是 autonomy 自己**：`15:41:13/14` 进程被换掉重启（`runtime.pid` mtime `15:41:13`、
   `server.log` mtime `15:41:14`，日志最后两行就是新进程 `[autonomy] version=cd3e7f54 listen=…`）；
5. 观察者随进程一起被杀 → monitor **没有行** → 至今显示 `pending`；同一条指令（`agent_messages` 1000014）也停在 `queued`。

14:11 的 plan 10 是**同一个模式**（那次 deploy 把版本换成 `5a4652a2` 并重启，monitor 至今 pending）→ 不是偶发：
**用 `service.deploy` 部署自己、又在同一 plan 里 `watch` 自己那次部署，观察者必然被「被观察的动作」杀掉。**
注意被观察的部署本身是**成功**的（`pipeline-e5f5c7db → succeeded → deployment-cd3e7f54` = 现在线上跑的版本），
所以 `pending ≠ 部署失败`；重启后也**不会补跑**旧 plan 剩下的 step（只有**新指令**才会 resume 那只 agent、开新 cycle）。

> 展示口径：我们若要把这种残留显示出来，应写「**未执行**（进程重启打断）」，不要写成「进行中」。

### A10. 主界面**四态**：规划中 / 执行中 / 阻塞 / 已完成（控制面侧展示层）

用户要的是「一眼看出这条任务处在哪一步」，而 autonomy 给的是**它自己的状态字汇**
（`running` / `pending` / `completed` / `unverified` / `blocked` / `need_input` / `error` / `stopped`）——
直接显示会让人问「这算在跑还是卡住了」。所以由**控制面把这些字汇翻成四个词**
（实现在 `web/src/autonomy.ts` 的 `executorPhaseView` + `web/src/components/ExecutorPhaseBar.tsx`；
只依据 `GET /api/tasks/{id}/executor` 或 `GET /api/autonomy/tasks/{id}` 的同一个 payload，**不改 autonomy 的接口**）。

| 四态 | 判定（按优先级） | 界面上的依据行（例） |
|---|---|---|
| **已完成** | 任务状态 = `completed`（它说这条 task 结束了） | `执行方状态 completed：PR #113 已合入` |
| **阻塞** | ① `unverified`（**自称完成、引擎验证没过** —— 不当完成）<br>② 状态 = `stopped` / `blocked` / `need_input` / `error` / `failed`<br>③ 最新一轮「决定」= `blocked` / `need_input`（等外部 / 等输入）<br>④ `error` 字段非空 | `执行方自称已完成，但引擎验证没通过（unverified）：… —— 需要重试或人工确认` |
| **规划中** | 还没有任何**带步骤**的计划（`plans` 为空，或只有「决定」没有 steps）→ 这一轮还在规划 | `执行方还没给出这一轮的计划（拿到就显示在这里）` / `指令已受理，等执行方开始规划` |
| **执行中** | 已经有带步骤的计划在推进；上一轮计划执行完、最新一轮是「决定」时也算（它马上给下一步） | `最新计划 3 步：2 步已完成 · 第 3 步 review（pull_request.review）还没执行（可能在跑，也可能上次运行被中断）` |

「在等什么」优先取 `need`：状态或最新决定是 `need_input` / `blocked` 时，控制面读 plan 的 **`need`**
（接口上可能是 JSON **字符串**，例：`{"type":"approval","description":"A human must review, approve and merge …"}`），
拿不到才退回 `reason` —— 实测 `task-2c438baf5499b592` 就是「等人工 review/合 PR」这一类。

两条**硬口径**（都来自实测，见 A9.2）：

1. plan 里 `status=pending` 的步骤**不等于「正在跑」**（执行行是**跑完才写**的）→ 一律写
   「第 k 步 <名字>还没执行」，**不写「进行中」**；
2. `unverified` 不是完成态 —— 主界面必须让人看见它「自称完成但没验过」。

其它：

- **原始状态不隐藏**：四态条把 autonomy 的原始 status 放进 `title` 悬停（口径是「显示它真给的」，不是换个说法盖过去）；
- **首帧不画**（还没读到 detail 时不闪一个错的态）；
- 四态条挂在 `ExecutorTaskBody` 最上面 → **两种入口共用**（我们建的 `agentPath=autonomy` 任务、只在它那边存在的对账行）。

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

> 已关闭：~~仓库地址从哪来~~（autonomy 自行推导，第 3 节 ✅）· ~~列表按 project 过滤 + 行字段~~（已确认支持，A3 ✅）· ~~未知 project 的行为~~（**硬失败**，A2 ✅）· ~~`message_seq` 单调性 / 历史保留期~~（**跨重启单调 + 永久保留**，A6 ✅）· ~~两个来源的游标要不要对齐编号~~（**不需要**：各自独立、不共用不比较，见 A6.2 ✅）

### A10.1 阻塞态的交互口径：谁在挡 / 它在等什么 / 它给的选项 / 你自己写

**目的**：阻塞不是「再跑一次就好」。人打开详情要能一眼回答三件事：谁在挡、它在等什么、我能怎么答。
四块都在 `ExecutorBlockedPanel`（挂在四态条下面；**非阻塞态整块不渲染**，不占版面）。

**① 谁在挡 + 依据**（分类只来自它自己的字段，并把依据写出来 —— 不替它讲故事）：

| 它的字段 | 分类 | 依据（面板原文） |
|---|---|---|
| `need.type=approval` | 等你拍板 | 它标了 need.type=approval：要人批准 / 合入 |
| `need.type=decision` | 等你定 | 它标了 need.type=decision：要人定一个 |
| `status=need_input` | 等你的输入 | 执行方状态 need_input：要你的输入 |
| `decision=blocked` / `status=blocked` | 等外部 | 决策 blocked：它在等外部条件 |
| `status=error` / `failed` | 执行方出错 | 执行方状态 `<原始值>`：它出错了 |
| `status=stopped` | 执行方已停 | 执行方状态 `<原始值>`：它停下来了 |
| `status=unverified` | 验证未通过 | 执行方状态 unverified：它说做完了，引擎没认 |

**② 它在等什么**：**`need.description` 全文照抄**（接口上是 JSON 字符串，见 A10.2）。它这次没填 `need`
（老 payload 是 `{}`）就退到 `reason`，并在标题里**标明来源**：`它在等什么（need.description 原文）` /
`它给的理由（这次它没填 need，照抄 reason）`；两者都没有就直说「它没说明在等什么」——**不编**。

**③ 它给的选项**：**只认 `need.options` 里结构化的**（1..N，最多 9 条）。交互是**单选 + 确认**：
点一个选项就选中（高亮），再按 **【确认】** —— 选中的选项**原文**重新提交给 autonomy。
**用户不需要输入编号**：编号（1./2./3.）只是界面的事，既不投递它，也不用用户抄它。
投递复用输入框那条通道（同一个投递实现、同一份回执），不在面板里再发一遍。
散文里像 `(1) … (2) …` 的枚举**不当选项** —— 实测 `task-2c438baf5499b592` 的 `need.description`
把「范围二选一」和「请人合 PR」写在同一段长文里，猜错等于给用户看假选项。

**④ 自由输入永远在**：没有选项、或都不合适，就直接在输入框写自己的意见 —— 与【确认】走同一条通道
（`POST /api/tasks/{id}/messages`，只收文字、忙则排队）。

**三条硬口径**

- **不替它说话**：面板上每句话都能指到它的某个字段（分类 → `status`/`need.type`；等什么 → `need.description`/
  `reason`/`error`）。**没有**任何我们自己写的固定话术模板（v2.8 之前那版自造话术已删）。
- **不猜**：选项只来自 `need.options`；散文枚举不解析。
- **不假装知道时间**：payload 里没有「何时开始阻塞」→ 只显示「本页看到这个状态已 N 分钟（页面观察，它那边不给时间）」，
  状态 / 计划 / 分类一变就重新计时。

**投递语义（要与 autonomy 对齐）**：【确认】投递的是**选项原文**（它自己写的文本，它必然能对上）；
**不投**界面生成的编号（1/2/3 是我们加的，它不知道）。用户自己的意见走输入框（同一条通道）。
面板 → 通道的接口是 `web/src/executorReply.ts`（`submitExecutorReply` 把话交给当前挂着的投递通道，
拿回 `{ok, receipt|error}`）；没有挂载通道就明确说「没有投递」，不假装已投。

**实测证据**

- `task-2c438baf5499b592`（`status=need_input`）最后一条决策：
  `need = {"type":"approval","description":"The web-cursor feature is implemented and open as PR …/pull/117,
  and the context report is open as PR …/pull/136, but completion contract C2 requires the change to be merged …"}`
  → 面板显示「等你拍板」+ 两个可点 PR 链接 + 自由输入。
- 同一任务更早一条 `need.type=decision`：`… (1) Scope decision: … (2) Approval/action to land: …` → 这是**散文枚举**，
  不当选项（见 ③）。
- `autonomy` 侧 `Need` 的结构：`src/decision.go` 只有 `type` + `description`；`recordPlan` 用 `jsonNeed(decision.Need)` 落库，
  `api_service.go` 把它当**字符串**返回（`plans[].need`）。

### A10.2 建议 autonomy 给 `need` 加结构化 `options`（**已实现**：autonomy #137）

现状：选项只能藏在 `description` 的散文里（上一条实测：枚举还与长解释混在同一段）。建议：

```go
type Need struct {
    Type        string   `json:"type"`
    Description string   `json:"description"`
    Options     []string `json:"options,omitempty"` // 需要人择一时列 2..9 条；开放问题留空
}
```

- **规则：非空才校验**（≥2 项、去空、去重、≤9）。`description` 的必填规则（`blocked.need_describes_what_is_missing`）不变。
- **为什么不要「强制必填」**：`blocked` 的真实形态常是「没有能力能做这件事」（autonomy 自己的测试里就是
  `Need{Type:"capability", Description:"nothing available can do this"}`）——**没有真选项**；强制只会逼 planner 编选项，
  比散文更难辨真假。
- **兼容**：`jsonNeed` 是 `json.Marshal(need)` + `omitempty` → 老 payload 一字不变；控制面已把它当 JSON 字符串解析、
  未知键忽略，**不需要版本协商**。
- **控制面这边已经兼容**：有 `options` 就渲染 1..N（见 A10.1 ③），没有就只有自由输入。

### A10.3 「验证」单独成一节：引擎那一侧的判定（已实现）

`status=unverified` 只说结论（它自称完成、引擎没认），**依据**原先只挤在四态条那一行提示里。
现在详情页多一节「验证（引擎判定）」（`web/src/components/ExecutorVerification.tsx`），数据来自 autonomy 的
`GET /api/tasks/{task_id}` → `verification`（autonomy #139；控制面 `/api/tasks/{id}/executor` 与
`/api/autonomy/tasks/{id}` 都是纯代理，原样带出）。

| 字段 | 页面上是什么 |
|---|---|
| `contract[]`（cycle 1 钉住，之后不改写） | 每条判据一行：`name` + `requirement`（判据原文）+ 它绑的**证据槽**（`evidence.source`）+ `expect`，右边是这条判据**最近一次**判定的结果 |
| `verdicts[]`（只追加；一条判据每轮 `done` 一行） | 「判定记录（N 次：pass / fail / inconclusive）」折叠块，最新在前：结果 + 判据名 + cycle + 问的谁（`method`）+ 期望 vs 实际 + 原文 `reason` |

**口径（三条硬规矩）**：

1. **三种「没有」分开说**（不合并成一句假话）：接口上没 `verification` 字段 = 引擎**从没判过**这条任务；
   有字段但 `contract` 空 = 它自称过 `done` 却**没钉过完成契约**；有契约没判定 = 契约在、还没有哪一轮 `done` 被拿去过。
2. **只有全 `pass` 才算数**：最近一轮里只要有一条不是 `pass`，这一节的结论就是「没过」，并**点名**哪条判据、
   什么结果、为什么（`reason` 原文截断，悬停看全文）。**不从 `status` 猜**：状态字在四态条与状态条上已经有了。
3. **判据原文照抄**：`requirement` / 证据槽 / `expect` 都从 `criterion` 原文里取（接口上是 JSON 字符串或对象都认）；
   解析不出来就说「它没写 requirement」，**不替它编一条**。`result` 只认 `pass` / `fail` / `inconclusive` 三个词，
   别的照原文放着（徽章按 inconclusive 显示）。

**实测证据**（`task-2c438baf5499b592`，远端 PG：`completion_contract` 2 行 + `verification` 9 行）：

- 契约：`C1`「A report documenting this task's known context information … is produced」（证据槽
  `step:report.output.summary`，期望 `exists=true`）、`C2`「The refactor change is landed (merged) on the base branch
  of the autonomy repository」（证据槽 `step:land.output.merged`，期望 `field=merged · equals=true`）；
- 判定：`C1` / `C2` 多轮 `inconclusive`（`method=-` 表示没有权威来源能回答这个证据槽，`method=registry:…`
  表示问了某个能力）→ 最近一轮没过，所以 `status=unverified`；页面上这一节就是那条结论的完整来处。

> 部署依赖：autonomy 侧要先上 #139（`verification` 字段）。**没上之前这一节显示「引擎还没判过这条任务」**
> —— 那是**如实**的（字段确实还没来），不是「判过、全过」。

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
| `POST /api/autonomy/tasks/{id}/messages` | `GET /api/tasks/{id}` + `POST /api/tasks {task_id, description}` | 只收文字（带图 400）· 未知 id → `404` 且**不投递** · 不可达 → `503`；**数据库无新增行**（纯代理） |
| `POST /api/autonomy/tasks` | `POST /api/tasks` | autonomy 不可达 → `503`；**数据库无新增行** |
| `GET /api/autonomy/meta` | `GET /api/meta` | 不可达 → `200 {available:false, error}`（不 500） |
| `GET /api/autonomy/tasks` | `GET /api/tasks` | 同上，透传 |
| `GET /api/autonomy/tasks/{id}` | `GET /api/tasks/{id}` | 404 原样透传 |

> **落库口径（v2）**：新入口**要**写我们的 `tasks` 行（任务是谁建的）、交接结果写 `agent_path` / `executor_task_id` / `executor_agent_id`，并写一条审计事件（`executor_attached` / `executor_failed`）；**不写** run / 不产生本地事件流。测试同时断言：**读接口**（`/api/autonomy/*`、`/executor`）一次都不写库。

## 6. 范围与后续

- **本契约覆盖**：M1 = 新入口创建 + 列表 + 详情（可用性/状态/计划）。控制面侧只做代理，前端只做查询。
- **M1 的展示口径**：任务仍只有一套 —— `agentPath = autonomy` 的行并进同一个侧栏列表、详情渲染在同一个主区（同一套 chip / 版式，只是数据来自代理）；**没有独立页面 / 入口**，也没有「autonomy 任务」这个类别。该路径暂时拿不到的字段一律留空不显示。
- **M1.5（本次）**：**继续对话**（A2③）—— 详情底部（我们建的任务）与**对账行**（只在 autonomy 那边存在的任务）的输入框都把消息**投递**给执行方（文字、忙则排队），回执写清 `message_id` / 「它前面还有几条」；前端还只显示**本页投递过的那几条**（它那边的完整对话 = 事件流，属 M2）。
- **M2（下一份）**：时间线（A6 映射：`role` 枚举 + 工具入参/结果 + 每轮终态）、停止（A7）。
- **M3（可选）**：广播（A8）、把 evaluation 侧的对比页串起来。
- **不做**：把 autonomy 的 runs / 事件 / 对话镜像进我们的库（看板 / 用量 / 统计仍只统计本机跑的）、双向同步、双建「对照任务」（已明确砍掉）。<br>（v2 起：**任务行**是我们建的，所以「落库」指的是我们的 task 行；执行数据仍在它那边。）

## 7. 切换与下线（未来）：兼容只是过渡态

前提（业务侧计划）：**后续一旦切过去，现在的旧入口（控制面本机 agent）就会下线。** 由此：

- **不需要为兼容做基建**：不为两边的编号/数据做对齐（见 A6.2）、不做双向同步、不把 autonomy 的任务镜像进控制面（见第 0 节「不落库」）。双跑窗口内**互不影响**就够了。
- **保留老入口的唯一意义是「可回退」**：双跑窗口里留着它是**行为回退**能力，不是数据兼容要求。
- **为下线那天准备的两件事（控制面侧，不影响本契约的接口）**：
  1. **入口做成开关，而不是两套代码**：建议 `TASK_ENTRY=both|autonomy|gateway`（默认 `both`）。切换 / 下线只是改配置，不需要改代码 + 发版；老入口下线时前端只需隐藏那个入口。
  2. **旧任务保持只读可用**：老任务的行与事件仍在控制面库里（`events.seq` 永久保留），下线后仍要能**只读**查看它们的详情 / 时间线；**不迁移、不合并**进 autonomy。
- **不建长期耦合**：任何「把两个来源放进同一视图」的东西（合并时间线、跨库 join、对照任务）都不做；将来真需要时用 `(source, id)` 复合键（见 A6.2）。

## 8. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.11 | 2026-09-21 | autonomy 任务状态轮询 **5s → 10s**（列表 `App.tsx` 与详情 `AutonomyTaskPanel.tsx` 共用 `AUTONOMY_TASK_REFRESH_MS`，不再各写一个数）。10s 的来由：状态是给人看的、一轮决策动辄几分钟，5s 只是更频繁地读到同一个值；手动动作（投递 / 重试 / 切任务）仍走**立刻重读**，不等计时到点 |
| v2.10 | 2026-09-21 | 新增「**验证**」section（A10.3）：把引擎那一侧的判定单独铺开 —— cycle 1 钉住的契约（判据原文 + 证据槽 + 期望）与每次判定（结果 / 问的谁 / 期望 vs 实际 / reason）。三种「没有」分开说、只有全 pass 才算数、判据原文照抄。数据来自 autonomy #139 的 `verification` 字段；四态条的 unverified 提示现在指到这一节 |
| v2.9 | 2026-09-21 | 阻塞面板的选项交互改成**单选 + 确认**：点一个选项（高亮选中）→ 按 **【确认】** 就把它的**原文**重新提交给 autonomy；**用户不用输入编号**（编号只是界面生成，既不投递也不让人抄）；投递复用输入框那条通道（`web/src/executorReply.ts` 的 `submitExecutorReply`，同一份回执；没挂通道就明说没投）。上一版的「点一下填进输入框」与 `executorPrefill` 一并移除；测试同步（单选/确认禁用态/不需要编号/通道空串不发且失败原文回传） |
| v2.8 | 2026-09-21 | 新增 **A10.1 阻塞态交互口径**（`ExecutorBlockedPanel`）：分类+依据 / `need.description` 全文（它没填就退 `reason` 并**标明来源**）/ **只认 `need.options` 的结构化选项**（点一下填进输入框、不自动投递）+ 自由输入永远在；**删掉自造话术**、不猜散文枚举、时间只报「本页观察」；另加 **A10.2**：建议 autonomy 给 `need` 加 `options`（**不强制必填**，附理由与兼容说明）。**口径归并**：四态文案只留一套（`task-status.ts` 取 `autonomy.ts` 的 `EXECUTOR_PHASE_LABEL`），详情页重复的状态徽标删除（侧栏列表徽标保留）；新增 `web/scripts/test-executor-blocked-ui.mjs`（已进 `npm test`）。**不做**：停止任务按钮（A7 未代理，属 M2） |
| v2.7 | 2026-09-21 | 四态条的「等什么」口径：`need_input` / `blocked` 时读 plan 的 **`need`**（接口上是 JSON 字符串，取 `description`；拿不到退回 `reason`）——`task-2c438baf5499b592` 实测显示「在等人工 review/合 PR」而不是一条泛泛的 reason |
| v2.6 | 2026-09-21 | 新增 **A10 主界面四态（规划中 / 执行中 / 阻塞 / 已完成）**：autonomy 的状态字汇由控制面**展示层**翻成四个词（`web/src/autonomy.ts` `executorPhaseView` + `ExecutorPhaseBar`），只依据接口原字段、不改它的接口；硬口径：`pending` 的步骤写「还没执行」**不写进行中**、`unverified` 算**阻塞**不算完成；原始状态留悬停；四态条挂在 `ExecutorTaskBody` → 两种入口共用；新增 `web/scripts/test-executor-status.mjs`（已进 `npm test`，47 个脚本） |
| v2.5 | 2026-09-21 | 新增 **A9.2 `pending` 是什么**：`steps[].status=pending` 是 autonomy 的**默认值**（计划有、`execution_step` 无）；而 step 行/日志都在 `cap.Run()` **返回后**才写 → 执行中被打断＝永远 pending。实测：plan 14 的 `deployment.monitor{watch:true}` 跟着的正是**部署 autonomy 自己**那次流水线，15:41:13/14 自重启把观察者杀掉；plan 10（14:11）同模式。被观察的部署其实成功，pending ≠ 失败，且重启不补跑旧 step |
| v2.4 | 2026-09-21 | 新增 **A9.1 谁干的活**：`execution_step.agent_id` 是**委托方**（planner），不是 worker；worker 每次委托都**新建**（`Runtime.AcquireAgent` 首行 `agents.NewAgent()`，无复用分支；复用只针对 planner）——附 `execution_step_interaction.reason_turn_id → reason_turns.agent_id` 的映射链与三批指令 → 10003/10007/10008 实测 |
| v2.3 | 2026-09-21 | 新增 **A9 数据落点与粒度**：线上 autonomy 库是 **PostgreSQL**（那份 `data/autonomy.db` SQLite 已是旧库，对着它查会得到「这条 task 没数据」的假象）；`agent_messages`（任务级对话）/ `reason_turns`（每次 LLM 调用）/ `llm_messages`（每条消息）/ `llm_events`（流式事件，本部署未落）**粒度不同、行数天然不等**（`llm_messages.turn_id` ↔ `reason_turns.id` 是 **N:1**，实测 41 : 5），附「真·错配」判据与只读自查 SQL |
| v1 | 2026-09-20 | 初稿：A1–A8 接口需求 + 控制面提供的接口 + 5 条阻塞级问题；对 `:4300` 实测标注 |
| v1.1 | 2026-09-21 | **仓库来源已确认**：由 autonomy **自行推导「项目 → 仓库」**（project → department.departmentId → 服务中心 组织服务清单），控制面无需新增接口；⚠️ 阻塞项关闭，阻塞级问题 5 → 4 条 |
| v1.2 | 2026-09-21 | **列表已确认**：`GET /api/tasks` 支持按 `project_id` 过滤，每行带 `project_id` / `agent_id` / `updated_at`（A3 ✅）；阻塞级问题 4 → 3 条 |
| v1.3 | 2026-09-21 | 三个答复落纸：**未知 project → 硬失败**（A2 ✅）· **`message_seq` 跨重启单调 + 历史永久保留**（A6 ✅）· 新增 **A6.1 事件模型要求**（要与我们现有时间线一致所需的 `role` 枚举 / 工具入参结果 / 每轮终态 / `cycle`，含降级代价）→ 第 4 节 3 条收敛为 1 条 |
| v1.4 | 2026-09-21 | 新增 **A6.2 游标作用域**：控制面 `events.seq` 是单库全局 `AUTOINCREMENT`（按 task 稀疏、与其它 task 交错，实测 min=1/max=509266/105 tasks），autonomy `message_seq` 是它库内的全局单调 id；**两边各自独立、不共用不比较，因此不需要对齐编号空间**（并写明若将来合并展示要用 `(source, seq)` 复合键；需要的保证只有：全局单调 / 跨重启单调 / 永久保留） |
| v2.2 | 2026-09-21 | **对账行也能 chat**：新增 `POST /api/autonomy/tasks/{id}/messages`（按**它那边的** task id 投递，同样只收文字 / 先确认存在 / 纯代理不写库），`AutonomyTaskPanel`（对账行详情）挂上同一个输入框 |
| v2.1 | 2026-09-21 | **「继续对话」已落地（M1.5）**：实测确认 A2③（同一 `task_id` 再 POST = 追加指令、忙则排队）→ 控制面 `POST /api/tasks/{id}/messages` 对 `agentPath=autonomy` 改为**投递给执行方**（`task_id` + `description`），返回 `202 {executor:true, executorTaskId, messageId, queueAhead, executorStatus}`，本机不跑 run；带图 400 且不投递、投递前先确认执行方真有这条 task（否则它会**新建**一条）、不可达 503 原文。前端：同一个 `ChatInput` 的执行方变体（只收文字、无模式选择、忙则排队）+ 投递回执 + 本页投递记录 |
| v2.0 | 2026-09-21 | **任务归属定稿**：任务始终由**控制面创建并落库**（`POST /api/tasks` + `agentPath`），autonomy 只负责**执行**（agent 由它创建）；我们存 `executor_task_id` / `executor_agent_id` 做对应，新增 `GET /api/tasks/{id}/executor` 按我们的 taskId 读执行方状态，`POST /api/autonomy/tasks` 下线（创建入口统一）。交接失败 → 任务保留 + `error` + 原文（`executor_failed`），绝不回落本机执行。第 0 节「不落库」改为「执行数据不镜像」 |
| v1.6 | 2026-09-21 | **展示口径定稿**：任务只有一套（都是 web-cursor 的任务），区别只在 **agent 创建路径**（`agentPath`：`control-plane` / `autonomy`）→ 同一个侧栏列表、同一个详情外壳、**没有独立页面**；接口暂时拿不到的字段一律**留空不显示**（等 M2 补齐）。第 0 节「不落库」明确为**数据层**约束（界面上合并 ≠ 控制面存了这些行） |
| v1.5 | 2026-09-21 | 新增 **第 7 节「切换与下线（未来）」**：旧入口最终会下线 → **兼容只是过渡态**，双方都不为兼容做基建（不对齐编号、不双向同步、不镜像任务）；控制面侧只需两件事：入口做成开关（`TASK_ENTRY`：`both` / `autonomy` / `gateway`）+ 旧任务保持只读可用。原第 7 节变更记录顺延为第 8 节 |
