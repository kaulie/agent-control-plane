# 两条 prompt：初始化 system prompt × task prompt（分开独立管理）

| 项 | 值 |
|---|---|
| 状态 | v1.0 — 已落地（`buildTaskPrompts` / `GET|PATCH /api/tasks/:id/prompts` / 「任务意图」面板两块） |
| 单一真源 | `backend/src/task-context.ts`（`buildInitSystemPrompt` + `buildTaskPromptText` + `buildTaskPrompts`） |
| 测试 | `backend/scripts/test-task-prompts.mjs` · `web/scripts/test-task-prompts-ui.mjs`（两条 prompt 互不影响的硬断言） |

## 0. 一句话

一个 task 有**两条 prompt**，**分开存储、分开编辑、分开投递、分开留痕**：

| | 初始化 system prompt | task prompt |
|---|---|---|
| 装什么 | **只讲协议**：角色 / 工作区隔离 / 仓库与 PR 规则 / 代理规则 / 交付目标规则 / 部署规则 | **这一单的具体信息**：身份（taskId、title、type、goal、project、workspace、createdAt、已有 PR）、服务中心给的仓库清单、需求原文、最近历史、本轮用户消息的引导尾 |
| 不许装什么 | **这条 task 的任何具体信息**（id / 标题 / 工作区路径 / 目标值 / PR URL / 仓库清单都不许出现） | 协议（怎么写代码、怎么交付）不该重复 |
| 存在哪 | `tasks.system_prompt`（空 = 用模板生成） | `tasks.description`（+ 事件流里的历史） |
| 默认值 | `buildInitSystemPrompt()` —— **对所有 task 同一份**（无参数，天然不含具体信息） | 用户创建任务时填的「需求原文」 |
| 送哪 | session 的 **system 通道**（Cline）；Cursor SDK 的 `AgentOptions` 没有 system 通道 → 作为**独立第一块**前置在同一段消息里 | **用户消息**（新开会话时前置） |
| 什么时候生效 | **开会话**（session create）：改了它，当前会话要等重建 / 轮转 / fork | 描述改了 → 进下一次会话的 task prompt；历史每轮都在 |

两块合起来 = 一次会话模型实际看到的那段文本（`TaskBootstrap.text`），中间用 `\n\n---\n\n`（`PROMPT_SEPARATOR`）分开。

## 1. 为什么要分开

- **职责不同**：协议是「怎么干活」的长期约定（跨 task 一样），具体信息是「这一单要什么」。混在一段里时，
  改协议会碰到需求、改需求会碰到协议 —— 谁都不好管；也说不清「模型拿到的规则是哪一版」。
- **system 通道才是协议该去的地方**：Cline 有真正的 system prompt（开会话时设置一次）；分开后协议走那条通道，
  不再伪装成用户消息里的一个块。
- **可审计**：`run_started` 事件分开记 `initSystemPromptSource`（`task` / `template`）、`initSystemPromptChars`、
  `taskPromptChars`、以及合成全文 `bootstrapText` —— 「这次会话用的是模板还是这条 task 自己那份」是可查的。

## 2. 管理入口（两处都分得开）

**模板住在文件里**

| 那一份 | 存在哪 | 怎么改 |
|---|---|---|
| **初始化 system prompt 的模板** | `backend/src/agent_policy/PROTOCOL.md`（**文件**，3032 字符；`npm run build` 会拷进 `backend/dist/agent_policy/`） | 直接改文件：每次渲染都**读盘、没有缓存** → **下一次会话**生效，不用重启（部署上改 `dist/agent_policy/PROTOCOL.md` 也一样） |
| **task prompt 的内容** | `tasks.description`（DB 里的需求原文）+ 运行时拼的身份 / 仓库清单 / 历史 | 面板上改描述（`PATCH { description }`） |
| 某条 task 自己那份**覆盖** | `tasks.system_prompt`（DB） | 面板上「改这一块」/「恢复模板」 |

- 读法在 `backend/src/prompt-files.ts` 的 `loadPromptFile`：**相对模块自己所在目录**（dev = `src/`、部署 = `dist/`）→ 读盘 → 裁掉尾部换行。
- 构建必须把它拷进产物（`npm run build` → `copy:prompts` → `scripts/copy-agent-policy.mjs`）：**部署里只有 `dist/`**，没有 `src/`。
- **读不到的后果**：模板是**必需资产** —— 缺文件 / 空文件**大声失败**（报错带绝对路径），**不**退回一份藏在代码里的旧文案。
- `PROMPT_FILES_ROOT` 可以把基点指到别处（测试、别的打包布局用；默认 = 模块自己所在目录）。
- 面板的「恢复模板」= 读这个文件（`GET /api/tasks/:id/prompts` 的 `systemPrompt.template` 就是它）。

**接口**

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/tasks/:id/prompts` | 两块**生效文本**：`systemPrompt.{text,source,template,maxChars}` + `taskPrompt.{text,description,chars}`。规则与真正开会话时**同一套**（同一个 `buildTaskPrompts`），所以看到的就是模型会拿到的那份 |
| `PATCH` | `/api/tasks/:id` `{ systemPrompt }` | 只改**初始化 system prompt**；`null` / 空串 = 清掉覆盖（回模板）；超 `MAX_SYSTEM_PROMPT_CHARS`（8000）= `400` |
| `PATCH` | `/api/tasks/:id` `{ description, ... }` | 只改 **task prompt** 那条轴（描述不允许改成空） |

两个 `PATCH` **各带各的字段**，互不覆盖（store 层就是分列落库）。

**面板**（「任务意图」面板，pin 在聊天框上方）：折叠按钮 `▾ 提示词` 展开后是**两个块** ——
`task prompt`（需求原文）与 `初始化 system prompt`（协议，只读预览 + 来源 + `✎ 改这一块` / `恢复模板`）。
两块**各自保存**：改 system prompt 不会动 task prompt，反之亦然。

## 3. 边界与已知取舍

- **只在新会话生效**：两条 prompt 都是「开会话时注入一次」。当前会话里改，模型这一轮看不到（时间线会留一条
  `任务意图已更新`）；下一会话（重启 / 轮转 / fork）才带上。这是 session 模型的固有限制，不是遗漏。
- **执行方是 autonomy 的 task**：本机不建会话 → 面板**不显示**「初始化 system prompt」那块（免得看起来像生效了），
  也不去拉 `/prompts`。
- **预算**：两块**加起来** `MAX_BOOTSTRAP_CHARS`（10000）。历史段优先保尾部（最近的内容一定留），
  丢了哪些行会写进 `TaskBootstrap.dropped`。
- **老任务逐字节**：`tasks.system_prompt` 为 NULL → 用模板，不 backfill；老任务的 task prompt 里也不会凭空多出
  `goal` / PR / 仓库行（没有就不写）。
