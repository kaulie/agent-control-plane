/**
 * 控制面 taskType / goal → autonomy goal_type / completion_contracts。
 *
 * 守住：类型只映射工作分类；目标才生成完成契约；没有目标就不传契约。
 *
 * Usage: npx tsx backend/scripts/test-autonomy-handoff.mjs
 */
import assert from "node:assert/strict";
import {
  AUTONOMY_GOAL_FEATURE,
  AUTONOMY_GOAL_RESOLVE_ISSUE,
  autonomyCompletionContract,
  autonomyGoalType,
  autonomyHandoffFromTask,
} from "../src/autonomy-handoff.ts";
import { TASK_GOAL_CATALOG } from "../src/task-goals.ts";

assert.equal(autonomyGoalType("feature"), AUTONOMY_GOAL_FEATURE);
assert.equal(autonomyGoalType("general"), AUTONOMY_GOAL_FEATURE);
assert.equal(autonomyGoalType(undefined), AUTONOMY_GOAL_FEATURE);
assert.equal(autonomyGoalType("bugfix"), AUTONOMY_GOAL_RESOLVE_ISSUE);
assert.equal(autonomyGoalType("diagnose"), AUTONOMY_GOAL_RESOLVE_ISSUE);

assert.equal(autonomyCompletionContract(undefined), undefined);
assert.equal(autonomyCompletionContract("refactor"), undefined);

const merge = autonomyCompletionContract("merge");
assert.ok(merge);
assert.equal(merge.steps.length, 1);
assert.equal(merge.steps[0].name, "merged_to_main");
assert.equal(
  merge.steps[0].requirement,
  TASK_GOAL_CATALOG.find((g) => g.id === "merge").directive,
);

const deploy = autonomyCompletionContract("deploy");
assert.ok(deploy);
assert.equal(deploy.steps[0].name, "merged_and_deployed");
assert.equal(
  deploy.steps[0].requirement,
  TASK_GOAL_CATALOG.find((g) => g.id === "deploy").directive,
);

const featureMerge = autonomyHandoffFromTask({ taskType: "feature", goal: "merge" });
assert.equal(featureMerge.goalType, AUTONOMY_GOAL_FEATURE);
assert.deepEqual(featureMerge.completionContracts, merge);

const bugfixDeploy = autonomyHandoffFromTask({ taskType: "bugfix", goal: "deploy" });
assert.equal(bugfixDeploy.goalType, AUTONOMY_GOAL_RESOLVE_ISSUE);
assert.deepEqual(bugfixDeploy.completionContracts, deploy);

const legacy = autonomyHandoffFromTask({ taskType: "general" });
assert.equal(legacy.goalType, AUTONOMY_GOAL_FEATURE);
assert.equal("completionContracts" in legacy, false, "老任务没有 goal → 不传契约");

console.log("test-autonomy-handoff: ok");
