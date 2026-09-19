/**
 * 任务「目标」前端单测（创建任务对话框的第二个选项）：
 *
 * - 目录口径：**就两个选项**（合入主分支 / 合入主分支并部署上线），默认选中前者；
 * - 未知 / 空值 → `undefined`（老任务没目标，保持「开完 PR 即停」），**不**回落到默认值；
 * - 创建对话框真的渲染出「目标」这两个 chip，且默认选中「合入主分支」；
 * - 任务意图面板把目标显示成徽标（老任务显示「仅开 PR」）。
 *
 *   npx tsx web/scripts/test-task-goal-ui.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";
const { default: CreateTaskDialog } = await import(
  "../src/components/CreateTaskDialog.tsx"
);
const { default: TaskIntentPanel } = await import(
  "../src/components/TaskIntentPanel.tsx"
);
const {
  DEFAULT_TASK_GOAL,
  TASK_GOAL_OPTIONS,
  isTaskGoal,
  normalizeTaskGoal,
  taskGoalLabel,
} = await import("../src/task-goals.ts");

// ---- 1) 目录口径 ----
assert.deepEqual(
  TASK_GOAL_OPTIONS.map((o) => o.id),
  ["merge", "deploy"],
  "需求就两个目标：合入主分支 / 合入主分支并部署上线（顺序也按需求）",
);
assert.deepEqual(
  TASK_GOAL_OPTIONS.map((o) => o.label),
  ["合入主分支", "合入主分支并部署上线"],
);
const labels = TASK_GOAL_OPTIONS.map((o) => o.label);
assert.equal(new Set(labels).size, labels.length, "label 不能重复");
const shorts = TASK_GOAL_OPTIONS.map((o) => o.short);
assert.equal(new Set(shorts).size, shorts.length, "徽标短标签不能重复");
for (const option of TASK_GOAL_OPTIONS) {
  assert.ok(option.hint.trim(), `${option.id} 要有说明（用户得知道选它会干什么）`);
}
assert.equal(DEFAULT_TASK_GOAL, "merge", "默认目标 = 更保守的「合入主分支」");
assert.ok(isTaskGoal(DEFAULT_TASK_GOAL));

// 未知 / 空值 → 没有目标（老行为），而不是默认目标
assert.equal(normalizeTaskGoal(undefined), undefined);
assert.equal(normalizeTaskGoal(null), undefined);
assert.equal(normalizeTaskGoal("pr_only"), undefined);
assert.equal(normalizeTaskGoal("deploy"), "deploy");
assert.equal(taskGoalLabel("deploy"), "合入主分支并部署上线");
assert.equal(taskGoalLabel(undefined), undefined);

// ---- 2) 创建对话框：目标 chip + 默认选中 ----
const noop = async () => {};
const dialog = renderToStaticMarkup(
  React.createElement(CreateTaskDialog, {
    open: true,
    projectId: "project-1",
    onClose: () => {},
    onCreate: noop,
  }),
);
assert.ok(dialog.includes(">目标<"), "创建对话框要有「目标」这一项");
assert.ok(dialog.includes(">合入主分支<"), "选项 1：合入主分支");
assert.ok(dialog.includes(">合入主分支并部署上线<"), "选项 2：合入主分支并部署上线");
assert.ok(
  dialog.includes("intent-type-chip goal-merge selected"),
  "默认选中「合入主分支」",
);
assert.ok(
  !dialog.includes("intent-type-chip goal-deploy selected"),
  "「部署上线」不能被默认选中（部署必须是明确选择）",
);

// ---- 3) 任务意图面板上的目标徽标 ----
const baseTask = {
  taskId: "task-1",
  projectId: "project-1",
  title: "导出 CSV 少一列",
  createdAt: "2026-09-19T10:00:00.000Z",
  status: "active",
  workspace: "/tmp/ws",
  provider: "cursor",
  taskType: "bugfix",
  description: "最后一列缺失",
  lastUserInputAt: "2026-09-19T10:00:00.000Z",
};
const panelOf = (task) =>
  renderToStaticMarkup(
    React.createElement(TaskIntentPanel, { task, onSave: noop }),
  );

const deployPanel = panelOf({ ...baseTask, goal: "deploy" });
assert.ok(deployPanel.includes("task-goal-badge goal-deploy"));
assert.ok(deployPanel.includes("合入主分支并部署上线"));

const mergePanel = panelOf({ ...baseTask, goal: "merge" });
assert.ok(mergePanel.includes("task-goal-badge goal-merge"));

// 老任务（没有 goal）：明确显示「仅开 PR」，不能让用户误以为会自动合入
const legacyPanel = panelOf(baseTask);
assert.ok(legacyPanel.includes("task-goal-badge goal-none"));
assert.ok(legacyPanel.includes("仅开 PR"));
assert.ok(
  !legacyPanel.includes("task-goal-badge goal-merge") &&
    !legacyPanel.includes("task-goal-badge goal-deploy"),
  "老任务不能被显示成有目标（否则用户以为会自动合入 / 部署）",
);

console.log("✅ task-goal UI OK");
