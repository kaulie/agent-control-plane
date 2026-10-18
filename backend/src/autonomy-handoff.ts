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

/**
 * 一条 caller 钉住的判据：与 planner 首答同一套 JSON（`{"steps":[…]}`）。
 *
 * `requirement` 只是记录。autonomy 钉住后按 `(task_id, idx)` 不再改写，
 * 验证器只认 `evidence` + `expect`。缺这两者的判据会一直 `inconclusive`，
 * `done` 永远过不了。
 */
export type AutonomyContractCriterion = {
  name: string;
  requirement: string;
  evidence: { source: string };
  expect: { field: string; equals: string };
};

export type AutonomyCompletionContract = {
  steps: AutonomyContractCriterion[];
};

/**
 * 证据槽里的 step 名。契约在受理时就钉上，planner 在 runtime context 里看到
 * 这些槽，必须把 `code_edit` 的 step 叫做 `edit`、把 `service.deploy` 的 step
 * 叫做 `deploy`。名字对不上时验证是 inconclusive（「没有叫这个名字的 step」），
 * planner 改 step 名就能补上；缺 `expect` 则永远补不上。
 */
const EDIT_PR_URL = "step:edit.output.pr_url";
const DEPLOY_PIPELINE_ID = "step:deploy.output.pipeline_id";

function mergedToMain(requirement: string): AutonomyContractCriterion {
  return {
    name: "merged_to_main",
    requirement,
    evidence: { source: EDIT_PR_URL },
    expect: { field: "merged", equals: "true" },
  };
}

function mergedAndDeployed(requirement: string): AutonomyContractCriterion {
  return {
    name: "merged_and_deployed",
    requirement,
    evidence: { source: DEPLOY_PIPELINE_ID },
    expect: { field: "state", equals: "succeeded" },
  };
}

/**
 * 控制面「目标」是交付边界，映射成 autonomy 能判定的完成契约。
 * 老任务没有 goal → 不传契约，留给 planner 首答自己钉。
 *
 * `merge` 只钉「PR 已合入」。`deploy` 在这之上再钉「部署流水线成功」——
 * 一条判据只有一个证据槽，合入和上线必须分成两条，否则其中一件事验不到。
 */
export function autonomyCompletionContract(
  goal: unknown,
): AutonomyCompletionContract | undefined {
  const info = taskGoalInfo(goal);
  if (!info) return undefined;
  if (info.id === "deploy") {
    return {
      steps: [
        mergedToMain("PR 已合入主分支（main）。"),
        mergedAndDeployed(info.directive),
      ],
    };
  }
  return { steps: [mergedToMain(info.directive)] };
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
