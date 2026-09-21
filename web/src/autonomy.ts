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
  if (s === "completed") return "ok";
  if (s === "blocked" || s === "need_input" || s === "unverified") return "warn";
  if (s === "error") return "bad";
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

/** 计划里的所有步骤（摊平，便于一屏看完进展）；autonomy 还没给步骤时返回空数组。 */
export function planSteps(
  detail: AutonomyTaskDetail | null,
): Array<{ planId?: number; step: number; capability: string; status: string }> {
  const out: Array<{
    planId?: number;
    step: number;
    capability: string;
    status: string;
  }> = [];
  for (const plan of detail?.plans ?? []) {
    (plan.steps ?? []).forEach((s, i) => {
      out.push({
        ...(plan.id != null ? { planId: plan.id } : {}),
        step: i + 1,
        capability: s.capability || "step",
        status: s.status || "?",
      });
    });
  }
  return out;
}
