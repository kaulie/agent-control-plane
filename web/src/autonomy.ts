import type {
  AutonomyTaskDetail,
  AutonomyTaskSummary,
  Task,
  TaskListRow,
} from "./types";

/**
 * 「agent 创建路径 = autonomy」的任务的**展示适配层**（纯前端，不落库）。
 *
 * 任务只有一套：都是 web-cursor 的任务 —— 侧栏同一个列表、详情同一个外壳。
 * 真正的区别在**这条 task 的 agent 是谁创建的**（`.agentPath`）：
 * - `control-plane`：控制面在本地 agent 工作区创建（现状）；
 * - `autonomy`：由 autonomy 的 runtime 创建并执行（控制面只代理它的状态/进展）。
 *
 * 数据仍然只来自 `/api/autonomy/*`（控制面只代理、不落库）；**它暂时拿不到的字段就不显示**
 * （不置灰、不写占位），等它的接口补齐（M2：事件/消息）时再往同一个外壳里加。
 */

/** 列表行显示 / 排序用的时间：老列表口径是「最后活动」→ 用 autonomy 的 `last_at`。 */
export function autonomyRowTime(task: AutonomyTaskSummary): string {
  return task.lastAt || task.updatedAt || "";
}

/** 描述取首行做标题（老任务的 title 也是这个口径），过长就截断。 */
export function titleFromDescription(description: string, max = 60): string {
  const first = description.split("\n")[0]?.trim() ?? "";
  if (first.length <= max) return first;
  return `${first.slice(0, max)}…`;
}

/**
 * autonomy 任务 → 侧栏列表行（和老任务共用同一套行模型）。
 *
 * - `agentPath: "autonomy"` → 列表 meta 行会写清 agent 是谁创建的；
 * - `provider` 用它的 LLM 后端（拿不到就不给 → 那一格**留空**，不写占位）；
 * - 时间用「最后活动」→ 与老任务同一个排序口径（最后活动倒序）。
 */
export function autonomyTaskToRow(
  task: AutonomyTaskSummary,
  opts: { llmBackend?: string } = {},
): TaskListRow {
  const when = autonomyRowTime(task);
  return {
    taskId: task.id,
    projectId: task.projectId ?? "",
    title: titleFromDescription(task.description) || task.id,
    status: task.status,
    workspace: "",
    provider: opts.llmBackend?.trim() ?? "",
    ...(task.agentId != null ? { agentId: String(task.agentId) } : {}),
    description: task.description,
    turns: task.turns,
    createdAt: when,
    ...(when ? { lastUserInputAt: when } : {}),
    agentPath: "autonomy",
  };
}

/** 排序键：老列表是 `COALESCE(last_user_input_at, created_at) DESC`，这里同口径。 */
export function rowActivityMs(row: {
  lastUserInputAt?: string;
  createdAt?: string;
}): number {
  const raw = row.lastUserInputAt || row.createdAt || "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 本地任务行 → 列表行。
 *
 * `agentPath` **来自后端**（谁建的就是谁建的）；`executorStatus` 是执行方（autonomy）那边的
 * 状态 —— 有就显示它（真正在跑的是那边），拿不到就显示我们自己的状态。
 */
export function localTaskToRow(
  task: Task,
  opts: { executorStatus?: string; executorTurns?: number } = {},
): TaskListRow {
  const executorStatus = opts.executorStatus?.trim();
  return {
    ...task,
    agentPath: task.agentPath ?? "control-plane",
    ...(executorStatus ? { status: executorStatus } : {}),
    ...(opts.executorTurns != null ? { turns: opts.executorTurns } : {}),
  };
}

/**
 * 合成**一个**列表：本地任务 + autonomy 执行的任务，按最后活动倒序（与后端 listTasks 同口径）。
 *
 * 没有 autonomy 行时原样返回（老行为逐字不变，连顺序都不动）；本地列表本来就按这个键排好，
 * 再排一次是稳定排序。
 */
export function mergeTaskRows(
  local: TaskListRow[],
  autonomy: TaskListRow[],
  opts: { executorIds?: Set<string> } = {},
): TaskListRow[] {
  // 已经在我们这边建过、并交接出去的任务（按执行方 id 对上）不再重复显示一遍 ——
  // 它的「真身」是本地那行（点击进的是我们自己的任务详情）。
  const known = opts.executorIds ?? new Set<string>();
  const extra = autonomy.filter((row) => !known.has(row.taskId));
  if (extra.length === 0) return local;
  return [...local, ...extra].sort(
    (a, b) => rowActivityMs(b) - rowActivityMs(a),
  );
}

/** 状态 → 徽标配色（autonomy 的七态 + stopped）。 */
export function statusClass(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "running" || s === "pending") return "running";
  // step 的状态别称（plan.steps[].status）：`ok` / `succeeded` / `failed` / `in_progress` …
  if (s === "completed" || s === "ok" || s === "succeeded" || s === "success" || s === "done") {
    return "ok";
  }
  if (s === "in_progress" || s === "in-progress" || s === "executing") return "running";
  if (s === "blocked" || s === "need_input" || s === "unverified") return "warn";
  if (s === "error" || s === "failed" || s === "failure") return "bad";
  if (s === "stopped") return "stopped";
  return "";
}

/**
 * 详情里「这条任务的世界」：**只拼 autonomy 真给了的字段**（拿不到就整段不显示，不写占位）。
 * 例：`project=project-59c41b54 · org=D0005 AI研发部 · repo=https://…`
 */
export function worldLine(detail: AutonomyTaskDetail | null): string {
  if (!detail) return "";
  const ref = detail.context_ref ?? {};
  const parts: string[] = [];
  const project =
    detail.project?.id || (typeof ref.project === "string" ? ref.project : "");
  if (project) parts.push(`project=${project}`);
  const org = detail.project?.organization;
  const orgText = [org?.id, org?.name].filter(Boolean).join(" ");
  if (orgText) parts.push(`org=${orgText}`);
  const repo = detail.project?.git_repo_url?.trim();
  if (repo) parts.push(`repo=${repo}`);
  return parts.join(" · ");
}

/** ------------------------------------------------------------------ *
 * 计划（plan / steps）：主界面在跑任务时**最该看**的东西。
 *
 * 口径（照 autonomy 的接口原文，不自造字段）：
 * - `plans[]` 是**逐轮**给的（一个 cycle 一条，`plan_id` 递增）：`decision_type: "plan"` = 这一轮的
 *   执行计划（有 `steps`）；`"done"` 等 = 这一轮的**决定**（可能没有 steps，只有 `reason`）；
 * - 最新那条 plan 经常是「决定」（收尾说明）→ 所以「最新计划」和「最新**带步骤**的计划」分开取；
 * - 拿不到的（比如运行中 step 的局部进展）**不编、不占位**：只显示它真给的状态/耗时/产出/错误。
 * ------------------------------------------------------------------ */

/** step 原始 status → 归一化阶段（显示图标/配色用；原始文本照样显示）。 */
export type StepPhase = "done" | "running" | "failed" | "pending";

const DONE_STATUSES = new Set(["ok", "succeeded", "success", "done", "completed", "passed"]);
const RUNNING_STATUSES = new Set([
  "running",
  "in_progress",
  "in-progress",
  "executing",
  "active",
  "started",
  "queued",
]);
const FAILED_STATUSES = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "aborted",
  "timeout",
]);

/** 执行方那边「还在跑」的任务状态（其余当已结束；空/未知按「还在跑」处理）。 */
const ACTIVE_STATUSES = new Set([
  "running",
  "pending",
  "queued",
  "planning",
  "starting",
  "waiting",
  "",
]);

/** step 的阶段（未知 status → `pending`，但界面上永远显示原始文本）。 */
export function stepPhase(status: string | undefined): StepPhase {
  const s = (status ?? "").trim().toLowerCase();
  if (DONE_STATUSES.has(s)) return "done";
  if (RUNNING_STATUSES.has(s)) return "running";
  if (FAILED_STATUSES.has(s)) return "failed";
  return "pending";
}

/** 计划里的一步（只留界面要用的字段，全部来自接口原文）。 */
export interface PlanStepView {
  key: string;
  idx: number;
  name: string;
  capability: string;
  status: string;
  phase: StepPhase;
  durationMs?: number;
  error?: string;
  /** 成功产出摘要（优先 `output.summary`，否则拼标量字段）。 */
  outputSummary?: string;
  /** 这一步打算达到的效果（`expected_effect`，JSON 字符串会摊成 `k=v`）。 */
  expectedEffect?: string;
}

/** 一轮计划（plan_id / cycle / 决定 / 步骤）。 */
export interface PlanView {
  key: string;
  planId?: number;
  cycle?: number;
  decisionType?: string;
  reason?: string;
  /** 接口里的 `step_count`（规划了几步）。 */
  stepCount?: number;
  /** 接口里的 `executed`（执行了几步）。 */
  executed?: number;
  /**
   * 接口里的 `need`（原始形态：接口上可能是 JSON **字符串**也可能是对象）——
   * `need_input` / `blocked` 时它就是「它在等什么、要人做什么」。
   */
  need?: unknown;
  steps: PlanStepView[];
}

/** 显示成一行纯文本（对象/数组不硬塞进 UI）。 */
function plainText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** 产出摘要：`{ summary, pr_url }` → summary；没有 summary 就拼标量字段。 */
function summarizeOutput(output: unknown): string {
  if (output == null) return "";
  const direct = plainText(output);
  if (direct) return direct;
  if (typeof output !== "object") return "";
  const obj = output as Record<string, unknown>;
  const summary = plainText(obj.summary);
  if (summary) return summary;
  return Object.entries(obj)
    .map(([k, v]) => {
      const t = plainText(v);
      return t ? `${k}: ${t}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

/** `expected_effect`：JSON 字符串 → `creates=…`；不是 JSON 就原样。 */
function summarizeEffect(effect: unknown): string {
  const raw = plainText(effect);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const pairs = Object.entries(parsed as Record<string, unknown>)
        .map(([k, v]) => {
          const t = plainText(v);
          return t ? `${k}=${t}` : "";
        })
        .filter(Boolean);
      if (pairs.length > 0) return pairs.join(" · ");
    }
  } catch {
    /* 不是 JSON → 原样显示 */
  }
  return raw;
}

type RawPlan = NonNullable<AutonomyTaskDetail["plans"]>[number];
type RawStep = NonNullable<RawPlan["steps"]>[number];

function toStepView(planKey: string, step: RawStep, i: number): PlanStepView {
  const status = plainText(step.status);
  const duration = typeof step.duration_ms === "number" ? step.duration_ms : undefined;
  const error = plainText(step.error);
  const outputSummary = summarizeOutput(step.output);
  const expectedEffect = summarizeEffect(step.expected_effect);
  return {
    key: `${planKey}-s${step.idx ?? i + 1}`,
    idx: typeof step.idx === "number" ? step.idx : i + 1,
    name: plainText(step.name),
    capability: plainText(step.capability),
    status,
    phase: stepPhase(status),
    ...(duration != null ? { durationMs: duration } : {}),
    ...(error ? { error } : {}),
    ...(outputSummary ? { outputSummary } : {}),
    ...(expectedEffect ? { expectedEffect } : {}),
  };
}

function toPlanView(plan: RawPlan, i: number): PlanView {
  // 老写法（id）兼容；接口给的是 plan_id。
  const planId = typeof plan.plan_id === "number" ? plan.plan_id : plan.id;
  const key = `p${planId ?? `-${i}`}`;
  const steps = (plan.steps ?? []).map((s, si) => toStepView(key, s, si));
  const decisionType = plainText(plan.decision_type);
  const reason = plainText(plan.reason);
  const stepCount = typeof plan.step_count === "number" ? plan.step_count : undefined;
  const executed = typeof plan.executed === "number" ? plan.executed : undefined;
  const need = plan.need;
  return {
    key,
    ...(planId != null ? { planId } : {}),
    ...(typeof plan.cycle === "number" ? { cycle: plan.cycle } : {}),
    ...(decisionType ? { decisionType } : {}),
    ...(reason ? { reason } : {}),
    ...(stepCount != null ? { stepCount } : {}),
    ...(executed != null ? { executed } : {}),
    ...(need != null && need !== "" ? { need } : {}),
    steps,
  };
}

/** 逐轮计划（按 `plan_id`/`cycle` 升序；接口本来就是升序，这里再兜一次）。 */
export function planViews(detail: AutonomyTaskDetail | null): PlanView[] {
  const plans = (detail?.plans ?? []).map(toPlanView);
  return plans
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.planId ?? a.p.cycle ?? a.i) - (b.p.planId ?? b.p.cycle ?? b.i))
    .map((x) => x.p);
}

/** 最新一轮计划（**可能就是「决定」**、没有 steps）。 */
export function latestPlan(detail: AutonomyTaskDetail | null): PlanView | undefined {
  return planViews(detail).at(-1);
}

/** 最新一轮**带步骤**的计划（跑的时候就是它）。 */
export function latestSteppedPlan(detail: AutonomyTaskDetail | null): PlanView | undefined {
  return planViews(detail)
    .filter((p) => p.steps.length > 0)
    .at(-1);
}

/** 这一步的进展统计：已完成 / 总步数（总数优先用接口的 `step_count`）。 */
export function stepProgress(plan: PlanView | undefined): {
  done: number;
  failed: number;
  total: number;
} {
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.phase === "done").length;
  const failed = steps.filter((s) => s.phase === "failed").length;
  const total = plan?.stepCount ?? steps.length;
  return { done, failed, total: Math.max(total, steps.length) };
}

/**
 * 「当前 step」：正在跑的 → 失败的 → 下一个待执行的（都完成 → undefined）。
 * 只在这条 plan 就是在执行的那条时有意义（调用方自己判断）。
 */
export function currentStep(plan: PlanView | undefined): PlanStepView | undefined {
  const steps = plan?.steps ?? [];
  return (
    steps.find((s) => s.phase === "running") ??
    steps.find((s) => s.phase === "failed") ??
    steps.find((s) => s.phase === "pending")
  );
}

/** step 的名字（`land（pull_request.review）`）。 */
export function stepLabel(step: PlanStepView | undefined): string {
  if (!step) return "";
  const name = step.name || step.capability;
  if (step.name && step.capability) return `${name}（${step.capability}）`;
  return name;
}

export type PlanPhase = "loading" | "planning" | "planned" | "none";

/**
 * 主界面该显示哪种计划态：
 * - `loading`：还没读到（首帧）—— 不显示、也不闪「正在规划」；
 * - `planning`：还没形成 plan、任务仍在跑 → **正在规划**；
 * - `planned`：有 plan → 显示最新 plan + steps；
 * - `none`：已结束且从没给过 plan（照实说「没有计划」，不谎称还在规划）。
 */
export function planPhase(opts: {
  loaded: boolean;
  plans: PlanView[];
  status: string | undefined;
}): PlanPhase {
  if (!opts.loaded) return "loading";
  if (opts.plans.length > 0) return "planned";
  const s = (opts.status ?? "").trim().toLowerCase();
  return ACTIVE_STATUSES.has(s) ? "planning" : "none";
}

/** 执行方是不是「正在忙」（决定 chat 的措辞：忙就排队）。 */
export function executorBusy(status: string | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "running" || s === "pending" || s === "queued" || s === "planning";
}

/**
 * 投递回执（chat 输入发出去之后的回话）—— **只写接口真给了的**：
 * `message_id` / `queued`（它前面还有几条）/ `status`（执行方状态）。
 *
 * 例：`已投递给执行方 · 指令 #1000010 · 前面还有 0 条`
 */
export function deliveryReceipt(res: {
  executor?: boolean;
  messageId?: number;
  /** = autonomy 的 `queued`（它前面还有几条）。 */
  queueAhead?: number;
  executorStatus?: string;
}): string {
  const parts = ["已投递给执行方（autonomy）"];
  if (res.messageId != null) parts.push(`指令 #${res.messageId}`);
  if (typeof res.queueAhead === "number") {
    parts.push(res.queueAhead > 0 ? `前面还有 ${res.queueAhead} 条` : "马上处理");
  }
  if (res.executorStatus) parts.push(`它那边状态 ${res.executorStatus}`);
  return parts.join(" · ");
}

/** ------------------------------------------------------------------ *
 * 主界面**四态**：规划中 / 执行中 / 阻塞 / 已完成。
 *
 * 为什么要有它：autonomy 自己的状态字汇（`running` / `unverified` / `stopped` /
 * `need_input`…）是**它的**口径，主界面直接显示出来问「这算在跑还是卡住了」；
 * 这里把它翻成用户要的四个词，并**在括号里写清依据**（只写接口真给了的字段）。
 *
 * 判定（按优先级，全部来自 `GET /api/tasks/{id}` 或 `/api/executor` 的同一个 payload）：
 *
 * | 四态 | 依据 |
 * |---|---|
 * | **已完成** | 任务状态 = `completed`（它说这条 task 结束了） |
 * | **阻塞** | 状态 = `stopped` / `blocked` / `need_input` / `error` / `failed`；<br>或 `unverified`（**自称完成、引擎验证没通过** —— 不当作完成）；<br>或**最新一轮是「决定」**且决定为 `blocked` / `need_input`（在等外部/等输入）；<br>或 `error` 字段非空 |
 * | **规划中** | 还没形成任何**带步骤**的计划（`plans` 为空，或只有「决定」没有 steps）→ 还在等这一轮的 plan |
 * | **执行中** | 已经有带步骤的计划（正在推进）；上一轮计划全部执行完、最新一轮是「决定」时也算执行中（它马上要给出下一步） |
 *
 * 两条硬口径（都是实测过的坑，见 docs/autonomy-integration.md 的 A9.2）：
 * 1. plan 里 `status=pending` 的步骤**不等于「正在跑」** —— 执行行是**跑完才写**的，
 *    所以这里写成「第 k 步 <名字> 还没执行」，**不写「进行中」**；
 * 2. `unverified` 不是完成态：它是「执行方自称做完、引擎没验过」，主界面必须让人看见。
 * ------------------------------------------------------------------ */

/** 主界面四态。 */
export type ExecutorPhase = "planning" | "executing" | "blocked" | "done";

/** 四态的固定文案（用户要的就是这四个词，不跟着 autonomy 的字汇变）。 */
export const EXECUTOR_PHASE_LABEL: Record<ExecutorPhase, string> = {
  planning: "规划中",
  executing: "执行中",
  blocked: "阻塞",
  done: "已完成",
};

/** 执行方说这条 task 结束了。 */
const FINISHED_STATUSES = new Set(["completed", "verified", "done", "succeeded", "success"]);

/** 「不是正常在跑」的状态 —— 都按**阻塞**显示（原始状态与原因写进依据）。 */
const BLOCKED_STATUSES = new Set([
  "stopped",
  "blocked",
  "need_input",
  "error",
  "failed",
  "failure",
]);

export interface ExecutorPhaseView {
  phase: ExecutorPhase;
  /** 角标文字：规划中 / 执行中 / 阻塞 / 已完成。 */
  label: string;
  /** 一句话依据（悬停看全文）。 */
  hint: string;
  /** 执行方的原始状态（拿不到就是空串）—— 角标悬停时照实给。 */
  raw: string;
}

/** 压成一行并截断（长 `reason` 不撑破版面；悬停看全文）。 */
function oneLine(text: unknown, max = 150): string {
  const raw = plainText(text).replace(/\s+/g, " ");
  if (!raw) return "";
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/**
 * `need` 解析：autonomy 把 need 记成 JSON，接口上可能是**字符串**（常见）也可能是对象。
 * 返回对象形态（解不开就当纯文本，由调用方用 `plainText(need)` 兜底）。
 */
function needRecord(need: unknown): Record<string, unknown> | null {
  if (need && typeof need === "object" && !Array.isArray(need)) {
    return need as Record<string, unknown>;
  }
  const direct = plainText(need);
  if (!direct) return null;
  try {
    const parsed = JSON.parse(direct) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // 不是 JSON 字符串 → 当纯文本用
  }
}

/**
 * `need` 里的「它在等什么」：取最常见的几个键
 * （`description` / `text` / `question` / `reason` / `message`）——它拿不到就退回 `reason`。
 */
function needText(need: unknown): string {
  const obj = needRecord(need);
  if (obj) {
    for (const key of ["description", "text", "question", "reason", "message"]) {
      const t = plainText(obj[key]);
      if (t) return t;
    }
    return "";
  }
  return plainText(need);
}

/** 这条 task 在主界面该显示成哪一态（`detail` 还没读到时由调用方决定不画）。 */
export function executorPhaseView(detail: AutonomyTaskDetail | null): ExecutorPhaseView {
  const raw = (detail?.status ?? "").trim();
  const s = raw.toLowerCase();
  const plan = latestPlan(detail);
  const decision = (plan?.decisionType ?? "").toLowerCase();
  const err = oneLine(detail?.error);
  const why = oneLine(plan?.reason) || err;
  const view = (phase: ExecutorPhase, hint: string): ExecutorPhaseView => ({
    phase,
    label: EXECUTOR_PHASE_LABEL[phase],
    hint,
    raw,
  });

  // ① 已完成：它说这条 task 结束了。
  if (FINISHED_STATUSES.has(s)) {
    return view("done", why ? `执行方状态 ${raw}：${why}` : `执行方状态 ${raw}`);
  }
  // ② 阻塞（一）：自称完成但引擎没验过 —— 不能当完成。
  if (s === "unverified") {
    return view(
      "blocked",
      `执行方自称已完成，但引擎验证没通过（unverified）${why ? `：${why}` : ""}` +
        " —— 需要重试或人工确认；为什么没认，见下面「验证」一节",
    );
  }
  // ② 阻塞（二）：停了 / 出错 / 被挡 / 等输入。
  //    状态本身就是 `need_input` / `blocked` 时，「在等什么」以 `need` 为准（比 `reason` 具体）。
  if (BLOCKED_STATUSES.has(s)) {
    const ask =
      decision === "blocked" || decision === "need_input" ? oneLine(needText(plan?.need)) : "";
    const tail = ask || err || why;
    return view("blocked", `执行方状态 ${raw}${tail ? `：${tail}` : ""}`);
  }
  // ② 阻塞（三）：它自己给出的最新一轮「决定」是在等外部 / 等输入。
  //    等什么，`need` 里说得比 `reason` 具体（例：`{"type":"approval","description":"等人 review/合 PR #117"}`）。
  if (decision === "blocked" || decision === "need_input") {
    const ask = oneLine(needText(plan?.need)) || why;
    return view("blocked", `执行方在等外部 / 等输入（${decision}）${ask ? `：${ask}` : ""}`);
  }
  // ③ 规划中：还没有任何「带步骤」的计划 —— 这一轮还在规划。
  const stepped = latestSteppedPlan(detail);
  if (!stepped) {
    return view(
      "planning",
      s === "pending"
        ? "指令已受理，等执行方开始规划"
        : "执行方还没给出这一轮的计划（拿到就显示在这里）",
    );
  }
  // ④ 执行中：已有带步骤的计划在推进。
  if (plan && plan.steps.length === 0) {
    // 最新一轮是「决定」（没有步骤）→ 上一轮的计划已经跑完，它正在给下一步。
    const { done, total } = stepProgress(stepped);
    return view("executing", `上一轮计划 ${total} 步：${done} 步已执行完，执行方正在给出下一步`);
  }
  const { done, failed, total } = stepProgress(stepped);
  const next = currentStep(stepped);
  const head = `最新计划 ${total} 步：${done} 步已完成${failed ? ` · ${failed} 步失败` : ""}`;
  const tail = next
    ? ` · 第 ${next.idx} 步 ${stepLabel(next)}还没执行（可能在跑，也可能上次运行被中断）`
    : " · 已全部执行完";
  return view("executing", `${head}${tail}`);
}

/** ------------------------------------------------------------------ *
 * 阻塞态：把「它在等什么 / 它给了哪些选项 / 你能怎么答」备齐。
 *
 * 事实（拿线上 payload 核过，别再靠猜）：
 * - `need` 是**字符串里的 JSON**：`{"type":"approval|decision|…","description":"…"}`；
 *   真实样本里 `description` 会把选择写成散文枚举（`(1) … (2) …`），所以这一层**不猜枚举**：
 *   只有 autonomy 在 `need.options` 里**结构化**给出时才当选项，其余交给用户在输入框自己写。
 * - 它没填 `need`（老 payload 是 `{}`）时退到 `reason`，并**标明**这段话来自 reason。
 * ------------------------------------------------------------------ */

/** 阻塞分类：来自它自己的 `status` / `need.type`（不是我们替它编的）。 */
export type BlockedKind =
  | "approval"
  | "decision"
  | "input"
  | "external"
  | "error"
  | "stopped"
  | "unverified";

const BLOCKED_KIND_LABEL: Record<BlockedKind, string> = {
  approval: "等你拍板",
  decision: "等你定",
  input: "等你的输入",
  external: "等外部",
  error: "执行方出错",
  stopped: "执行方已停",
  unverified: "验证未通过",
};

/** 每个分类的**依据**：照实说它是靠哪个字段判出来的（`{s}` 换成原始值）。 */
const BLOCKED_KIND_BASIS: Record<BlockedKind, string> = {
  approval: "它标了 need.type=approval：要人批准 / 合入",
  decision: "它标了 need.type=decision：要人定一个",
  input: "执行方状态 need_input：要你的输入",
  external: "决策 blocked：它在等外部条件",
  error: "执行方状态 {s}：它出错了",
  stopped: "执行方状态 {s}：它停下来了",
  unverified: "执行方状态 unverified：它说做完了，引擎没认",
};

export interface LinkView {
  url: string;
  label: string;
}

/** URL → 短标签（PR / 流水线 / 部署 / 其它）。 */
export function linkLabel(url: string): string {
  const pr = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (pr) return `${pr[1]}/${pr[2]} PR #${pr[3]}`;
  const pipe = /\/api\/pipelines\/([^/?#]+)/.exec(url);
  if (pipe) return `流水线 ${pipe[1]}`;
  const dep = /\/deployments\/([^/?#]+)/.exec(url);
  if (dep) return `部署 ${dep[1]}`;
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

/** 文本里的链接（去重、去掉尾部标点）—— 面板把它们变成可点的证据。 */
export function linksIn(text: string): LinkView[] {
  const out: LinkView[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/[^\s<>()[\]"'\uff0c\u3002\uff1b\u3001\uff09]+/g;
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label: linkLabel(url) });
  }
  return out;
}

/** 选项上限：面板按 1..N 编号，超过 9 就不列了（超出的交给自由输入）。 */
export const MAX_NEED_OPTIONS = 9;

/**
 * `need.options` → 干净的选项：**只认它真给的**（字符串、非空、去重、最多 9 条）。
 * 没有这个字段 / 不是数组 → 空数组（= 它没给选项，没有选项就不显示选项）。
 */
export function needOptions(need: unknown): string[] {
  const rec = needRecord(need);
  const raw = rec ? rec.options : undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "";
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_NEED_OPTIONS) break;
  }
  return out;
}

/** 这段话是从哪来的（面板要写明，不让人以为它一定说了）。 */
export type BlockedAskSource = "need" | "reason" | "error" | "none";

export interface BlockedView {
  kind: BlockedKind;
  /** 标题：等你拍板 / 等你定 / 等你的输入 / 等外部 / 执行方出错 / 执行方已停 / 验证未通过。 */
  kindLabel: string;
  /** 依据：靠哪个字段判出来的（照实说）。 */
  basis: string;
  /** 它自己的 need.type（approval / decision / capability…），没有就是空串。 */
  needType: string;
  /** 它在等什么 / 在问什么：`need.description` 全文（照抄，不转述）。 */
  ask: string;
  /** `ask` 的来源（面板照实标注）。 */
  askSource: BlockedAskSource;
  /** 它给的理由（面板里折叠）。 */
  reason: string;
  /** **结构化**选项（`need.options`）；空 = 它没给选项（那就只走自由输入）。 */
  options: string[];
  /** `ask` / `reason` 里的链接（PR / 流水线…）。 */
  links: LinkView[];
  /** 「复制阻塞详情」用的一行。 */
  summaryLine: string;
}

/**
 * 阻塞态的面板原料；**不是阻塞态就返回 `null`**（面板不渲染、不占版面）。
 * `phase` 可以由调用方传进来（它已经算过四态），省一次重复计算。
 */
export function blockedView(
  detail: AutonomyTaskDetail | null,
  phase?: ExecutorPhaseView,
): BlockedView | null {
  const view = phase ?? executorPhaseView(detail);
  if (view.phase !== "blocked") return null;
  const raw = (detail?.status ?? "").trim();
  const s = raw.toLowerCase();
  const plan = latestPlan(detail);
  const needType = (() => {
    const rec = needRecord(plan?.need);
    return rec ? plainText(rec.type).trim() : "";
  })();
  const needFull = needText(plan?.need).trim();
  const reason = oneLine(plan?.reason, 600);
  const errText = oneLine(detail?.error, 400);
  const ask = needFull || reason || errText;
  const askSource: BlockedAskSource = needFull
    ? "need"
    : reason
      ? "reason"
      : errText
        ? "error"
        : "none";
  const decision = (plan?.decisionType ?? "").trim().toLowerCase();
  const needTypeLower = needType.toLowerCase();
  const kind: BlockedKind =
    needTypeLower === "approval"
      ? "approval"
      : needTypeLower === "decision"
        ? "decision"
        : s === "unverified"
          ? "unverified"
          : s === "error" || s === "failed"
            ? "error"
            : s === "stopped"
              ? "stopped"
              : s === "blocked" || decision === "blocked"
                ? "external"
                : "input";
  const links = linksIn(`${ask}\n${reason}`);
  const options = needOptions(plan?.need);
  return {
    kind,
    kindLabel: BLOCKED_KIND_LABEL[kind],
    basis: BLOCKED_KIND_BASIS[kind].replace("{s}", raw || "未知"),
    needType,
    ask,
    askSource,
    reason,
    options,
    links,
    summaryLine:
      `【阻塞 \u00b7 ${BLOCKED_KIND_LABEL[kind]}】${ask || reason}` +
      (options.length > 0 ? `（它给了 ${options.length} 个选项）` : "") +
      (links.length > 0 ? `（${links[0].url}）` : ""),
  };
}

// ---- 验证（引擎自己那一侧的「做完了吗」）----------------------------------------
//
// `status=unverified` 只是一个状态字；它为什么没被认，答案在 autonomy 的
// `verification` 里（cycle 1 钉住的完成契约 + 每一次判定，docs/verification.md）。
// 这个 section 就是把那份事实铺开 —— 全部按它**真给的**说，缺哪样就说缺哪样：
// 没钉过契约、没判过、判据原文没写 requirement，都不编一个出来。

/** 一次判定的结果分类（只认 autonomy 的三个词，别的照原文放着）。 */
export type VerdictTone = "pass" | "fail" | "inconclusive" | "other";

/** 一条判定（界面要用的字段，全部来自接口原文）。 */
export interface VerifyVerdictView {
  key: string;
  id?: number;
  cycle?: number;
  criterion: string;
  /** 原始结果词（`pass` / `fail` / `inconclusive` / 别的）。 */
  result: string;
  tone: VerdictTone;
  /** 问的谁（`-` = 没有权威来源，判不了）。 */
  method: string;
  /** 证据槽与它解析成了什么（原文 JSON 摊平后的样子）。 */
  evidence: string;
  expected: string;
  observed: string;
  reason: string;
  createdAt?: string;
}

/** 契约里的一条判据 + 它最近一次判定。 */
export interface VerifyCriterionView {
  key: string;
  idx?: number;
  name: string;
  /** 判据要求什么（它自己写的 `requirement`；没写就是空串）。 */
  requirement: string;
  /** 它绑的证据槽（`evidence.source` / `evidence.slot`）。 */
  slot: string;
  /** 期望（`expect` 摊成 `k=v`）。 */
  expect: string;
  /** 这条判据最近一次判定（没判过就没有）。 */
  last?: VerifyVerdictView;
  passes: number;
  fails: number;
  inconclusives: number;
}

export interface VerificationView {
  /** 首帧还没读到 → 不画（免得先闪一句「没判过」再变）。 */
  loaded: boolean;
  /** 接口上**有没有** `verification` 这个字段：`false` = 引擎从没判过（不是判过全过）。 */
  present: boolean;
  contract: VerifyCriterionView[];
  /** 判定记录，**最新的在前**（界面上先看最近一次）。 */
  verdicts: VerifyVerdictView[];
  counts: { total: number; pass: number; fail: number; inconclusive: number };
  /** 最近一轮（cycle 最大那次）的判定。 */
  latestRound: VerifyVerdictView[];
  /** 一句话：现在到底算不算「做完」。 */
  headline: string;
  /** section 的整体色调：pass（最近一轮全过）/ fail / inconclusive / none（没判过）。 */
  tone: VerdictTone | "none";
}

function verdictTone(result: string): VerdictTone {
  const s = result.trim().toLowerCase();
  if (s === "pass") return "pass";
  if (s === "fail") return "fail";
  if (s === "inconclusive") return "inconclusive";
  return "other";
}

/** JSON 原文（可能是字符串也可能是对象）→ 对象；解不开就当空的。 */
function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const text = plainText(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 对象里的一串标量摊成 `k=v / k2=v2`（值是对象或数组就只留键名，不假装能读懂）。 */
function flatPairs(value: unknown): string {
  const obj = jsonRecord(value);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const text = plainText(v);
    if (text) parts.push(`${k}=${text}`);
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
    else if (v && typeof v === "object") parts.push(`${k}={...}`);
  }
  return parts.join(" \u00b7 ");
}

function toVerdictView(v: Record<string, unknown>, i: number): VerifyVerdictView {
  const result = plainText(v.result);
  const id = typeof v.id === "number" ? v.id : undefined;
  const cycle = typeof v.cycle === "number" ? v.cycle : undefined;
  const created = plainText(v.created_at);
  return {
    key: `${id ?? i}`,
    ...(id != null ? { id } : {}),
    ...(cycle != null ? { cycle } : {}),
    criterion: plainText(v.criterion),
    result,
    tone: verdictTone(result),
    method: plainText(v.method),
    evidence: flatPairs(v.evidence),
    expected: plainText(v.expected),
    observed: plainText(v.observed),
    reason: plainText(v.reason),
    ...(created ? { createdAt: created } : {}),
  };
}

/**
 * 引擎那一侧的验证：契约 + 判定 + 一句话结论。
 *
 * 三种「没有」必须分清，界面上的话也跟着分：
 * - 接口上没这个字段（`present: false`）→ 引擎**从没判过**这条任务；
 * - 有字段但 `contract` 空 → 它自称过 done，而**从来没钉过完成契约**，没判据可对照；
 * - 有契约没判定 → 契约在，但还没有哪一轮 done 被拿去过（或判定的都还没落库）。
 */
export function verificationView(detail: AutonomyTaskDetail | null): VerificationView {
  const raw = detail?.verification;
  const loaded = detail !== null;
  if (!loaded || !raw || typeof raw !== "object") {
    return {
      loaded,
      present: false,
      contract: [],
      verdicts: [],
      counts: { total: 0, pass: 0, fail: 0, inconclusive: 0 },
      latestRound: [],
      headline: loaded ? "引擎还没判过这条任务（接口上还没有验证记录）" : "",
      tone: "none",
    };
  }

  const verdicts = (Array.isArray(raw.verdicts) ? raw.verdicts : [])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map(toVerdictView);
  const counts = {
    total: verdicts.length,
    pass: verdicts.filter((v) => v.tone === "pass").length,
    fail: verdicts.filter((v) => v.tone === "fail").length,
    inconclusive: verdicts.filter((v) => v.tone === "inconclusive").length,
  };
  const cycles = verdicts.map((v) => v.cycle ?? 0);
  const latestCycle = cycles.length > 0 ? Math.max(...cycles) : 0;
  const latestRound = verdicts.filter((v) => (v.cycle ?? 0) === latestCycle);

  const contract = (Array.isArray(raw.contract) ? raw.contract : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c, i): VerifyCriterionView => {
      const crit = jsonRecord(c.criterion);
      const name = plainText(c.name) || plainText(crit.name);
      const evidence = jsonRecord(crit.evidence);
      const mine = verdicts.filter((v) => v.criterion === name);
      const last = mine.at(-1);
      return {
        key: `${name || c.idx || i}`,
        ...(typeof c.idx === "number" ? { idx: c.idx } : {}),
        name,
        requirement: plainText(crit.requirement),
        slot: plainText(evidence.source) || plainText(evidence.slot),
        expect: flatPairs(crit.expect),
        ...(last ? { last } : {}),
        passes: mine.filter((v) => v.tone === "pass").length,
        fails: mine.filter((v) => v.tone === "fail").length,
        inconclusives: mine.filter((v) => v.tone === "inconclusive").length,
      };
    });

  // 一句话结论只从**判定**里得，不从 `status` 猜：状态字在四态条与状态条上已经有了。
  // 判过而契约空是可能的（那一次 done 自己带了判据名）：这时要在结论里说清「没有钉住的契约」。
  const noContract = contract.length === 0 ? "（没有钉住的完成契约，判据名来自那次 done 自己）" : "";
  const bad = latestRound.filter((v) => v.tone !== "pass");
  let headline: string;
  let tone: VerdictTone | "none";
  if (verdicts.length === 0) {
    tone = "none";
    headline =
      contract.length > 0
        ? `契约在（${contract.length} 条判据），但还没有哪一轮 done 被判定过`
        : "没有钉住的完成契约，也没有判定：它自称做完也无从验证";
  } else if (bad.length > 0) {
    tone = bad.some((v) => v.tone === "fail") ? "fail" : "inconclusive";
    // 同一轮里同一条判据可能判过不止一次（每次 done 判定一次）：结论行按判据去重，
    // 免得同一句话念两遍（完整记录在下面的判定列表里，一条不少）。
    const seen = new Set<string>();
    const lines = bad
      .filter((v) => {
        const key = v.criterion || "?";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((v) => `${v.criterion || "?"} ${v.result}${v.reason ? `（${oneLine(v.reason, 80)}）` : ""}`);
    headline =
      `最近一轮（cycle ${latestCycle}）没过：` +
      lines.join("；") +
      " \u2014 只有全 pass 才算数，这条任务不算「做完」的来处就在这里" +
      noContract;
  } else {
    tone = "pass";
    headline = `最近一轮（cycle ${latestCycle}）判定全过（${latestRound.length} 条判据）${noContract}`;
  }

  return {
    loaded,
    present: true,
    contract,
    verdicts: [...verdicts].reverse(),
    counts,
    latestRound,
    headline,
    tone,
  };
}
