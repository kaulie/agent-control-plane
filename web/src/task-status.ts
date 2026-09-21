/**
 * autonomy 任务的「一眼可见」状态。
 *
 * 需求：主界面上，**agent 由 autonomy 创建的任务**（`agentPath === "autonomy"`）要直观显示
 * 当前状态，汇总成四个状态之一：**规划中 / 执行中 / 阻塞 / 已完成**。
 *
 * autonomy 自己给的 `status` 是更细的七态（`running` / `pending` / `completed` /
 * `unverified` / `blocked` / `need_input` / `error` / `stopped`），这里只是把它**汇总**成上面
 * 这四个大字，**不改变**任何原始文本 —— 列表 meta 行 / 详情状态条照旧原样显示它。
 *
 * 口径（产品确认）：
 * - 规划中：还没真正开跑（`pending` / `planning` / `queued` …），以及**未知 / 空值**
 *   （拿不到真实状态时按「还在准备」显示，与 `planPhase` 的兜底一致，不谎称已在执行）；
 * - 执行中：正在跑（`running` / `in_progress` / `executing` …）；
 * - 阻塞：跑不下去、需要人或出错（`blocked` / `need_input` / `unverified` / `error` /
 *   `stopped` …）—— 这四个状态里它是唯一的「要人看一眼」的；
 * - 已完成：收尾成功（`completed` / `done` / `ok` …）。
 */

export type TaskPhase = "planning" | "executing" | "blocked" | "completed";

export interface TaskPhaseOption {
  id: TaskPhase;
  /** 四个大字（需求原文）。 */
  label: string;
  /** 鼠标悬停的说明：它到底代表 autonomy 的哪些原始状态。 */
  hint: string;
}

export const TASK_PHASE_OPTIONS: TaskPhaseOption[] = [
  {
    id: "planning",
    label: "规划中",
    hint: "autonomy 正在准备 / 排队（pending、planning、queued…），还没真正开跑。",
  },
  {
    id: "executing",
    label: "执行中",
    hint: "autonomy 正在执行（running、in_progress、executing…）。",
  },
  {
    id: "blocked",
    label: "阻塞",
    hint: "跑不下去了、需要处理（blocked、need_input、unverified、error、stopped…）。",
  },
  {
    id: "completed",
    label: "已完成",
    hint: "autonomy 已收尾（completed、done、ok…）。",
  },
];

const BY_ID = new Map<TaskPhase, TaskPhaseOption>(
  TASK_PHASE_OPTIONS.map((option) => [option.id, option]),
);

/** 原始 status（大小写不敏感）→ 四个状态各自代表的原始值。 */
const EXECUTING = new Set(["running", "in_progress", "in-progress", "executing", "active", "started"]);
const BLOCKED = new Set([
  "blocked",
  "need_input",
  "unverified",
  "error",
  "failed",
  "failure",
  "stopped",
  "cancelled",
  "canceled",
  "aborted",
  "timeout",
]);
const COMPLETED = new Set(["completed", "done", "finished", "succeeded", "success", "ok", "passed"]);
const PLANNING = new Set(["pending", "planning", "queued", "starting", "waiting", "created"]);

/**
 * 任务原始 status → 四个大字之一。
 *
 * 依次匹配，命中即返回；**未知 / 空值回落到「规划中」**（拿不到状态时按「还在准备」，
 * 不谎称已在执行，也不谎称已完成）。
 */
export function taskPhase(status: unknown): TaskPhase {
  const s = String(status ?? "").trim().toLowerCase();
  if (EXECUTING.has(s)) return "executing";
  if (BLOCKED.has(s)) return "blocked";
  if (COMPLETED.has(s)) return "completed";
  if (PLANNING.has(s)) return "planning";
  return "planning";
}

export function taskPhaseOption(status: unknown): TaskPhaseOption {
  return BY_ID.get(taskPhase(status))!;
}

/** 四个大字（规划中 / 执行中 / 阻塞 / 已完成）。 */
export function taskPhaseLabel(status: unknown): string {
  return taskPhaseOption(status).label;
}

/** 徽标配色用的 class 后缀（`phase-planning` / `phase-executing` …）。 */
export function taskPhaseClass(status: unknown): string {
  return `phase-${taskPhase(status)}`;
}
