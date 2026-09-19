import type { TaskGoal } from "./types";

/**
 * 任务「目标」目录（前端）。后端有一份对应的 `backend/src/task-goals.ts`
 * —— 两个 workspace 不共享代码，所以两边各一份，靠
 * `web/scripts/test-task-goal-ui.mjs` 与 `backend/scripts/test-task-goal.mjs` 守住口径一致。
 *
 * 和「类型」不同：**目标会改变 agent 的交付动作**（合入主分支 / 再部署上线），
 * 类型只是分类标签。
 */
export interface TaskGoalOption {
  id: TaskGoal;
  /** 完整中文名（创建对话框的选项 / 面板徽标）。 */
  label: string;
  /** 徽标短标签。 */
  short: string;
  /** 一句话说明（创建对话框里给用户看的提示）。 */
  hint: string;
}

/** 新建任务的默认目标：合入主分支（两个选项里更保守的那个）。 */
export const DEFAULT_TASK_GOAL: TaskGoal = "merge";

export const TASK_GOAL_OPTIONS: TaskGoalOption[] = [
  {
    id: "merge",
    label: "合入主分支",
    short: "合入",
    hint: "开发完开 PR；检查通过后由 agent 自己合入 main，不部署。",
  },
  {
    id: "deploy",
    label: "合入主分支并部署上线",
    short: "合入+上线",
    hint: "在「合入主分支」基础上，再走部署平台把这次改动部署上线。",
  },
];

const BY_ID = new Map<TaskGoal, TaskGoalOption>(
  TASK_GOAL_OPTIONS.map((option) => [option.id, option]),
);

export function isTaskGoal(value: unknown): value is TaskGoal {
  return typeof value === "string" && BY_ID.has(value as TaskGoal);
}

/**
 * 未知 / 空值 → `undefined`（历史任务没设目标，保持老行为：开完 PR 停），
 * **不**回落到默认值，否则老任务会凭空多出一个「合入主分支」的徽标。
 */
export function normalizeTaskGoal(value: unknown): TaskGoal | undefined {
  return isTaskGoal(value) ? value : undefined;
}

export function taskGoalOption(value: unknown): TaskGoalOption | undefined {
  const goal = normalizeTaskGoal(value);
  return goal ? BY_ID.get(goal) : undefined;
}

export function taskGoalLabel(value: unknown): string | undefined {
  return taskGoalOption(value)?.label;
}
