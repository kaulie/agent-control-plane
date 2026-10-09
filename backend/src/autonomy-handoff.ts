import { normalizeTaskType } from "./task-types.js";
import { taskGoalInfo } from "./task-goals.js";
import type { Task, TaskGoal, TaskType } from "./types.js";

/**
 * 控制面 task → autonomy `POST /api/tasks` 的结构化交接。
 *
 * 类型 / 目标不能只写进 description：autonomy 认的是受理字段
 * `goal_type`（工作分类，见 autonomy `src/goal.go`）和
 * `completion_contracts`（完成契约，见 `src/completion_contract.go`）。
 * 描述里的「需求投递」给人看；这两项才是 planner / 验证器的输入。
 */

/** autonomy 用户可见的 GoalType（`src/goal.go`）。 */
export const AUTONOMY_GOAL_FEATURE = "dev_feature";
export const AUTONOMY_GOAL_RESOLVE_ISSUE = "resolve_issue";

export type AutonomyGoalType =
  | typeof AUTONOMY_GOAL_FEATURE
  | typeof AUTONOMY_GOAL_RESOLVE_ISSUE;

/**
 * 控制面「类型」是分类标签；autonomy 的 `goal_type` 是工作分类。
 * 修缺陷 / 定位 → `resolve_issue`，其余（新功能 / 通用）→ `dev_feature`。
 */
export function autonomyGoalType(taskType: unknown): AutonomyGoalType {
  switch (normalizeTaskType(taskType)) {
    case "bugfix":
    case "diagnose":
      return AUTONOMY_GOAL_RESOLVE_ISSUE;
    default:
      return AUTONOMY_GOAL_FEATURE;
  }
}

/** 一条 caller 钉住的判据：与 planner 首答同一套 JSON（`{"steps":[…]}`）。 */
export type AutonomyContractCriterion = {
  name: string;
  requirement: string;
};

export type AutonomyCompletionContract = {
  steps: AutonomyContractCriterion[];
};

/**
 * 控制面「目标」是交付边界，映射成 autonomy 完成契约的一条 requirement。
 * 老任务没有 goal → 不传契约，留给 planner 首答自己钉。
 */
export function autonomyCompletionContract(
  goal: unknown,
): AutonomyCompletionContract | undefined {
  const info = taskGoalInfo(goal);
  if (!info) return undefined;
  return {
    steps: [
      {
        name: info.id === "deploy" ? "merged_and_deployed" : "merged_to_main",
        requirement: info.directive,
      },
    ],
  };
}

export type AutonomyHandoffFields = {
  goalType: AutonomyGoalType;
  completionContracts?: AutonomyCompletionContract;
};

export function autonomyHandoffFromTask(
  task: Pick<Task, "taskType" | "goal"> | { taskType?: TaskType; goal?: TaskGoal },
): AutonomyHandoffFields {
  const goalType = autonomyGoalType(task.taskType);
  const completionContracts = autonomyCompletionContract(task.goal);
  return completionContracts ? { goalType, completionContracts } : { goalType };
}
