# 上下文（context）：体量口径 + 透明化契约

两件事：**算清"当前会话占了多少模型窗口"**，以及**让所有改变 agent 记忆的动作可见**。

## 一、体量口径（最容易踩错，务必先读 `size.ts` 顶部注释）

`usage` 事件的语义按 provider 不同：

| provider | 值 = | 单次请求体量 |
| --- | --- | --- |
| **cline** | **本 run 内累计**的 prompt tokens（run 开始从 0 计） | = 相邻两条的差；`v` 本身不是体量（38 次调用后就是 38.9M）|
| **cursor** | **agent 生命周期累计**（同一 run 内两条相等、跨 run 单调增） | 推不出来 → `available: false` + 原因，**不猜数** |

实测校准（2026-09-18，pdf-reader）：6.71MB 文本 ↔ 1,048,576 tokens ⇒ **≈6.4 字符/token**；
它最后一次调用 prompt = `38,962,680 − 37,916,440 = 1,046,240`，下一次请求就越过 1,048,576 →
会话永久卡死。这就是这个模块存在的理由。

⚠️ **不要**用 `stats.inputTokens`（跨调用累加，38.9M）冒充上下文 —— 两者差 37 倍，页面上同时出现，必须分开标注。

### token 估算的两个口径（`estimate.ts`）

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `MEASURED_CHARS_PER_TOKEN` | 6.4 | **展示**（"大概多少 token"最接近真实）|
| `CONSERVATIVE_CHARS_PER_TOKEN` | 3 | **阈值 / 守卫**（与 Cline SDK 的 `estimateTokens` 一致，故意高估 → 预警偏早）|

写进事件或给用户看的估算，两个数都给：`seededTokens`（实测比）+ `seededTokensUpperBound`（保守比）。

### 模型窗口

`limits.ts`：启动时 `warmModelLimits()` 读 provider 的模型目录（`@cline/llms` 的 deepseek-v4-* 报
`contextWindow / maxInputTokens = 1,000,000`、`maxTokens = 384,000`）。**不硬编码**；查不到就是
"窗口未知"（只给 tokens、不给百分比）。cursor 目录不带窗口 → 就是未知。

阈值：`CONTEXT_WARN_PERCENT = 70`（变黄）、`CONTEXT_ALERT_PERCENT = 85`（红 + 建议 fork）。

## 二、透明化契约（PR-5 起生效，新机制必须遵守）

> **任何改变 agent 上下文/记忆的操作（会话轮转、seed、简报注入、会话重置、restart 后重建）
> 都必须：写一条用户可见的时间线消息 + 一条可审计的结构化事件，并能回答"模型当前记得什么、丢了什么"。**

三类动作现在的落点：

| 动作 | 事件 | 页面表现 |
| --- | --- | --- |
| 网关重启 / 会话失效 → 以简报开新会话 | `status`：`{ status: "session_reset", previousAgentId, message }` | 时间线「会话已重置」+ 原因 |
| 切模式/会话失效 → seed 整段会话 | `agent_succession`：`seededMessages` + **`seededTokens` / `seededTokensUpperBound` / `seededChars` / `seededOverLimit`** | 时间线「seeded 1630 msgs ≈ 1.02M tokens」 |
| 新会话注入启动简报 | `run_started`：`bootstrapChars` / `bootstrapTruncated` / `bootstrapKept*` / `bootstrapDropped*` / **`bootstrapText`（原文）** | 时间线「简报 7.5K 字符（按预算裁剪：丢 8 条用户消息 / 4 条 run 结论）」 |

简报本身（`task-context.ts`）：固定骨架先占预算，剩下的按 **run 结论 40% : 用户消息 60%** 分，
两段都**从最新往回装（保尾部）**—— 修掉了老 bug：整段 `slice(0, 7500)` 超预算时会把
「### Recent run outcomes」整段砍掉（20 条用户消息就会触发）。裁剪量写进 `TaskBootstrap.dropped`。

## 三、文件

| 文件 | 内容 |
| --- | --- |
| `size.ts` | 纯函数：累计值 → 每次调用 prompt、每轮增量、换会话标记、百分比、剩余轮数估算 |
| `limits.ts` | 模型窗口缓存 + 预热（`modelContextLimit`）|
| `estimate.ts` | token 估算（实测比 / 保守比）|
| `index.ts` | 统一出口 |

前端：`web/src/context-format.ts`（徽标文案/阈值/柱高）+ `ContextMeter.tsx`（UsageBar 下方那条）；
时间线文案在 `web/src/components/Timeline.tsx` 的 `buildRows`（已导出，便于测试）。

测试：`backend/scripts/test-context-size.mjs`（口径）、`backend/scripts/test-transparency.mjs`（简报裁剪 +
seed 体量落库）、`web/scripts/test-context-format.mjs`、`web/scripts/test-timeline-events.mjs`。

## 四、防炸：三条线（PR-4）

| 线 | 谁在管 | 行为 |
| --- | --- | --- |
| **85%** `CONTEXT_ALERT_PERCENT` | 用户 | 常驻提示 + 发言时弹窗：建议 fork 新 task（自己决定）|
| **90%** | SDK（core 自带）| **启用 compaction** 后 core 自己压（`triggerRatio = 0.9`，basic = token 预算截断投影）|
| **88%** `CONTEXT_ROTATE_PERCENT` | 系统 | 兜底：换会话（run 开始前判定，见 `rotate.ts`）|
| **上一次 run 被窗口顶死** | 系统 | **无条件轮转** —— 否则再发一句只会再失败一次（不可逆）|

### 压缩为什么以前没生效（探针结论）

`@cline/core` 的压缩是 **opt-in**：`BY()` 里 `if (config.compaction?.enabled !== true) return;`，
返回 undefined 就等于**没有 `prepareTurn`** → 长会话只会撞 provider 硬上限，报
"no conversation history to compact"（pdf-reader 的死法）。
所以 cline provider 现在在 `buildConfig()` 里显式传
`compaction: { enabled: true, strategy: "basic" }`（不需要 summarizer；agentic 需要额外 provider，留给后续）。
→ `CLINE_COMPACTION=0` 可关。

### 自动轮转的判据（`rotate.ts`，纯函数）

```
rotate  ⟺  tokens + 本次输入  ≥  min(limit × 88%, limit − 60k)   或  上一次 run 就是上下文超限
```

- `tokens` = 最近一次模型调用的 prompt（`size.ts`），`limit` = 模型窗口；**任一未知 → 不轮转**（不猜）；
- `incomingTokens`：文本按实测比、图片按 1.5k/张 —— 用户贴一大段也会提前触发；
- 留 `60k` 余量：实测单个 run 内部还能自己长 ~66k；
- 轮转 = `startFresh`（新会话 + 启动简报，简报里就带最近历史）→ **不需要 seed**；
- `CONTEXT_AUTO_ROTATE=0` 可关（关掉后只留 85% 的 fork 提示 + 溢出时的可操作报错）。

### 透明化（契约在 §二）

| 动作 | 事件 | 页面 |
| --- | --- | --- |
| 自动轮转 | `status: context_rotation`（含 tokens/limit/percent/reason）+ `agent_succession`（`reason: "context_rotation"`，带 `contextTokens/contextLimit/contextPercent/rotateReason`）| 时间线「已自动轮转会话」+ 「上下文轮转 · 当时约 88%」|
| 撞上窗口（没救回来时）| 原始报错 | 页面把它翻成可操作中文：「上下文已超出模型窗口…请点 Fork 新 task」（`web/src/run-errors.ts`）|

## 五、两个「更好但不是必需」的增强（**默认关闭**）

### 1. 模型生成 digest（`CONTEXT_DIGEST=1` 开）

把工作历史**用模型压成交接摘要**，用在两个地方：

- fork 来的 task：摘要**替代**原始 `carried` 行（这才是 compaction —— 原始行会挤掉 7.5KB 简报里更有用的内容）；
- 上下文轮转在即：给新会话一份长期摘要（原始近况仍来自启动简报）。

实现（`digest.ts` + `gateway.contextDigestFor()`）：

- 只走 OpenAI 兼容的 `/chat/completions`（DeepSeek 就是），**不依赖 SDK**，另可 `CONTEXT_DIGEST_MODEL=…` 指定便宜模型；
- **永不抛错**：超时/HTTP 错/解析失败 → 返回 `undefined`，调用方回退原始历史（摘要失败绝不能让用户发不出消息）；
- **水位缓存**：写进 `tasks.context_digest/_at/_seq`，源 task 新增事件 ≤50 条就复用（不然每轮都烧一次模型）；
- **透明化**：生成时记一条 `status: digest`（含模型/字符数/来源），`GET /api/tasks/:id` 的 `contextDigest` 能读到**原文**，
  `run_started` 里带 `bootstrapDigestChars/Model`（时间线显示「含模型摘要 N 字符」）。

### 2. agentic 压缩（`CLINE_COMPACTION=agentic` 开，默认 `basic`）

core 的 `strategy: "agentic"` 是 **LLM 摘要式压缩**（比 basic 的截断投影保留更多信息），但需要 summarizer：
默认**沿用本 provider 的凭据与模型**（`CLINE_COMPACTION_MODEL=…` 可换），缺 `apiKey` 时自动退回 basic。

## 六、还没做

- `strategy: "agentic"`（LLM 摘要式压缩）需要单独的 summarizer provider；
- 轮转的"摘要式 digest"（目前直接用启动简报，含最近 20 条用户消息 + 10 个 run 结论）；
- cursor 侧只有"上一次超限"这一个信号（它的 usage 是 agent 累计值，推不出体量）。
- **PR-4**：自动轮转（70% 主触发 / 溢出重试兜底 / 85% 只告警）+ 轮转的透明化四件套 + 可关闭开关；
- 压缩探针：`@cline/core` 自带 compaction（触发比 0.9 / 目标 0.7 / 保留 20k），但实测没生效 ——
  需要确认是不是我们没把 `contextWindow/maxInputTokens` 喂给 runtime。
