/**
 * autonomy 任务「一眼可见状态」前端口径（需求：agent 由 autonomy 创建的任务，主界面上
 * 直观显示当前状态——规划中 / 执行中 / 阻塞 / 已完成）。
 *
 * 覆盖：
 * 1) 纯映射 `taskPhase`：autonomy 的细状态 → 四个大字，未知 / 空值回落「规划中」；
 * 2) 侧栏列表行：autonomy 行渲染状态徽标（`task-phase-badge phase-*`），
 *    本地任务不渲染这个徽标（它们照旧只有类型徽标，行为不变）；
 * 3) 详情状态条：同样渲染四个大字（由真实 status 驱动），原始 status 照旧显示。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-autonomy-status-ui.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";
const { default: TaskList } = await import("../src/components/TaskList.tsx");
const { ExecutorTaskBody } = await import("../src/components/AutonomyTaskPanel.tsx");
const { TASK_PHASE_OPTIONS, taskPhase, taskPhaseClass, taskPhaseLabel } =
  await import("../src/task-status.ts");

// ---- 1) 目录口径：就四个状态，顺序与文案按需求 ----
assert.deepEqual(
  TASK_PHASE_OPTIONS.map((o) => o.id),
  ["planning", "executing", "blocked", "completed"],
  "四个状态：规划中 / 执行中 / 阻塞 / 已完成（顺序也按需求）",
);
assert.deepEqual(
  TASK_PHASE_OPTIONS.map((o) => o.label),
  ["规划中", "执行中", "阻塞", "已完成"],
);
for (const option of TASK_PHASE_OPTIONS) {
  assert.ok(option.hint.trim(), `${option.id} 要有说明（说清它代表 autonomy 的哪些原始状态）`);
}

// ---- 2) 映射：autonomy 的细状态 → 四个大字 ----
const cases = [
  // 规划中
  ["pending", "planning"],
  ["planning", "planning"],
  ["queued", "planning"],
  ["RUNNING", "executing"], // 大小写不敏感
  ["running", "executing"],
  ["in_progress", "executing"],
  ["executing", "executing"],
  ["blocked", "blocked"],
  ["need_input", "blocked"],
  ["unverified", "blocked"],
  ["error", "blocked"],
  ["stopped", "blocked"],
  ["completed", "completed"],
  ["done", "completed"],
  ["ok", "completed"],
  // 未知 / 空值 → 规划中（拿不到状态时不谎称已在执行 / 已完成）
  [undefined, "planning"],
  [null, "planning"],
  ["", "planning"],
  ["weird-status", "planning"],
];
for (const [raw, want] of cases) {
  assert.equal(taskPhase(raw), want, `taskPhase(${JSON.stringify(raw)}) 应为 ${want}`);
}
assert.equal(taskPhaseLabel("running"), "执行中");
assert.equal(taskPhaseLabel("completed"), "已完成");
assert.equal(taskPhaseClass("blocked"), "phase-blocked");

// ---- 3) 侧栏列表：autonomy 行有状态徽标，本地行没有 ----
const baseTask = {
  taskId: "task-1",
  projectId: "project-1",
  title: "给我的任务加个状态徽标",
  createdAt: "2026-09-21T02:00:00.000Z",
  workspace: "/tmp/ws",
  provider: "autonomy",
  description: "描述",
  lastUserInputAt: "2026-09-21T02:00:00.000Z",
};
const listOf = (tasks) =>
  renderToStaticMarkup(
    React.createElement(TaskList, {
      projects: [],
      selectedProjectId: null,
      onSelectProject: () => {},
      onCreateProject: () => {},
      onRenameProject: () => {},
      onOpenProjectSettings: () => {},
      tasks,
      selectedId: null,
      onSelect: () => {},
      onCreate: () => {},
    }),
  );

const autonomyExecuting = listOf([
  { ...baseTask, status: "running", agentPath: "autonomy" },
]);
assert.ok(
  autonomyExecuting.includes("task-phase-badge phase-executing"),
  "autonomy 行要渲染「执行中」徽标",
);
assert.ok(autonomyExecuting.includes("执行中"), "徽标文案是「执行中」");
assert.ok(autonomyExecuting.includes("running"), "原始 status 仍在 meta 行（不因徽标而丢原文）");

const autonomyBlocked = listOf([
  { ...baseTask, status: "need_input", agentPath: "autonomy" },
]);
assert.ok(
  autonomyBlocked.includes("task-phase-badge phase-blocked"),
  "need_input → 阻塞",
);
assert.ok(autonomyBlocked.includes("阻塞"));

const autonomyDone = listOf([
  { ...baseTask, status: "completed", agentPath: "autonomy" },
]);
assert.ok(autonomyDone.includes("task-phase-badge phase-completed"));
assert.ok(autonomyDone.includes("已完成"));

// 本地任务（control-plane）照旧只显示类型徽标，不能冒出状态徽标
const local = listOf([
  {
    ...baseTask,
    status: "active",
    agentPath: "control-plane",
    taskType: "feature",
  },
]);
assert.ok(local.includes("task-type-badge type-feature"), "本地任务仍是类型徽标");
assert.ok(
  !local.includes("task-phase-badge"),
  "本地任务不应出现 autonomy 状态徽标（行为不变）",
);

// ---- 4) 详情状态条：四个大字 + 原始 status ----
const detailBar = renderToStaticMarkup(
  React.createElement(ExecutorTaskBody, {
    taskId: "task-exec-1",
    via: "task",
    row: { ...baseTask, status: "blocked", agentPath: "autonomy" },
  }),
);
assert.ok(
  detailBar.includes("task-phase-badge phase-blocked"),
  "详情条要有「阻塞」大字",
);
assert.ok(detailBar.includes("auto-status warn"), "原始 status 仍按老配色显示");
assert.ok(detailBar.includes("blocked"));

console.log("✅ autonomy task-status UI OK");
