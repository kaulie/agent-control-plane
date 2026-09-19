import type { TaskGoal } from "./types.js";

/**
 * 任务「目标」目录（唯一事实源）。
 *
 * 和「类型」不同：**目标会改变 agent 的交付动作**。类型只是分类标签（见 `./task-types.ts`），
 * 目标回答的是「这个任务做到哪一步才算完」：
 * - `merge`：做完 + 开 PR + **合入主分支**，到此为止；
 * - `deploy`：在 `merge` 之上再**部署上线**（走部署平台打包已合入的提交）。
 *
 * 所以它必须：
 * 1. 落库（`tasks.goal`），列表 / 面板能显示；
 * 2. 进「系统投递」的需求消息（用户能在时间线上看到系统告诉 agent 什么）；
 * 3. 进会话简报（重启 / 轮转 / fork 后目标不丢）。
 *
 * ⚠️ **缺省语义**：`goal` 为空（历史任务、内部任务如 watchdog 崩溃分析）时**不带任何目标**，
 * agent 维持老行为 —— 开完 PR 就停、不 merge、不部署。老任务的简报因此逐字节不变
 * （`buildTaskBootstrap` 只在有 goal 时才多出目标行，见 `task-context.ts`）。
 */
export interface TaskGoalInfo {
  id: TaskGoal;
  /** 完整中文名（创建对话框的选项 / 面板徽标）。 */
  label: string;
  /** 列表徽标用的短标签。 */
  short: string;
  /** 一句话说明（创建对话框里给用户看的提示）。 */
  hint: string;
  /**
   * 给 agent 的「交付目标」原文（系统投递消息 + 会话简报共用）——
   * 目标会改变行为，所以这句话就是行为约束的来源。
   */
  directive: string;
}

/** 新建任务的默认目标：合入主分支（两个选项里更保守的那个）。 */
export const DEFAULT_TASK_GOAL: TaskGoal = "merge";

export const TASK_GOAL_CATALOG: TaskGoalInfo[] = [
  {
    id: "merge",
    label: "合入主分支",
    short: "合入",
    hint: "开发完开 PR；检查通过后由 agent 自己合入 main，不部署。",
    directive:
      "完成后把 PR 合入主分支（main）即算交付完成；不要部署上线。",
  },
  {
    id: "deploy",
    label: "合入主分支并部署上线",
    short: "合入+上线",
    hint: "在「合入主分支」基础上，再走部署平台把这次改动部署上线。",
    directive:
      "合入主分支后还要部署上线：走部署平台（~/runtime/agent-control-plane-deployment，:4220）打包已合入的提交并重启服务，不要在 agent 进程里同步跑发版/重启脚本。",
  },
];

const BY_ID = new Map<TaskGoal, TaskGoalInfo>(
  TASK_GOAL_CATALOG.map((info) => [info.id, info]),
);

/** 合法目标 id（错误信息里列出来，便于调用方自查）。 */
export const TASK_GOAL_IDS: TaskGoal[] = TASK_GOAL_CATALOG.map((info) => info.id);

export function isTaskGoal(value: unknown): value is TaskGoal {
  return typeof value === "string" && BY_ID.has(value as TaskGoal);
}

/**
 * 归一化**已指定**的目标：未知 / 空值 → `undefined`（= 没设目标，老行为），
 * 而不是回落到默认值 —— 否则历史任务会凭空多出一个「合入主分支」的交付动作。
 * HTTP 新建入口单独负责「没传就用 `DEFAULT_TASK_GOAL`」（见 routes）。
 */
export function normalizeTaskGoal(value: unknown): TaskGoal | undefined {
  return isTaskGoal(value) ? value : undefined;
}

export function taskGoalInfo(value: unknown): TaskGoalInfo | undefined {
  const goal = normalizeTaskGoal(value);
  return goal ? BY_ID.get(goal) : undefined;
}

export function taskGoalLabel(value: unknown): string | undefined {
  return taskGoalInfo(value)?.label;
}
