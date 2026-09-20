/**
 * 「任务基础信息」条（`web/src/components/TaskIdsBar.tsx`）前端单测：
 *
 * - 口径：Task / Project / Org 三行**必须**都来自真实字段，不做任何猜测；
 * - Org = `project.department.departmentId`（注入 agent 的仓库地址就是按它查服务中心），
 *   项目没设部门时是**占位文案**（`missing`），不是一个可复制的假 id；
 * - Agent 行只在 task 真的绑定了 agent 时出现；
 * - 渲染出来的 markup 里能看到整条 id（不是 `#446e4f` 那种截断）。
 *
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/test-task-ids-bar.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";
const { default: TaskIdsBar, taskIdRows, NO_ORG_PLACEHOLDER } = await import(
  "../src/components/TaskIdsBar.tsx"
);

const task = {
  taskId: "task-446e4fcb823d4b53",
  projectId: "project-59c41b54",
  agentId: "agent-001",
};

// ---- 1) 三行基础信息 + agent 行 ----
const rows = taskIdRows(task, { orgId: "D0005", orgName: "AI研发部" });
assert.deepEqual(
  rows.map((r) => r.key),
  ["task", "project", "org", "agent"],
  "Task / Project / Org 恒有，Agent 绑定后才有",
);
assert.deepEqual(
  rows.map((r) => r.value),
  [task.taskId, task.projectId, "D0005", task.agentId],
  "值必须是原始 id（不截断、不加 #）",
);
for (const row of rows) {
  assert.ok(row.hint.trim(), `${row.key} 要有悬停说明`);
  assert.equal(row.missing, undefined, `${row.key} 有值时不算缺失`);
}

// ---- 2) 没设部门 → 组织行是占位（不可复制），不能编造 id ----
const noOrg = taskIdRows(task, {});
const orgRow = noOrg.find((r) => r.key === "org");
assert.ok(orgRow);
assert.equal(orgRow.value, NO_ORG_PLACEHOLDER);
assert.equal(orgRow.missing, true, "没有部门 = 没有组织 id，这是「缺失」而不是一个值");
// 空字符串 / 纯空白同样按缺失处理
assert.equal(taskIdRows(task, { orgId: "   " })[2].missing, true);

// ---- 3) 老任务没有 agentId → 不出现 Agent 行 ----
assert.deepEqual(
  taskIdRows({ taskId: "t", projectId: "p" }, { orgId: "D0001" }).map((r) => r.key),
  ["task", "project", "org"],
);

// ---- 4) 渲染：完整 id 就在页面上 ----
const html = renderToStaticMarkup(
  React.createElement(TaskIdsBar, {
    task: { ...task, title: "", createdAt: "", status: "active", workspace: "", provider: "cursor", taskType: "general" },
    orgId: "D0005",
    orgName: "AI研发部",
  }),
);
for (const value of [task.taskId, task.projectId, "D0005", task.agentId]) {
  assert.ok(html.includes(value), `页面上应能看到完整 id：${value}`);
}
assert.ok(html.includes("task-id-chip"), "用 chip 样式渲染");
assert.equal(
  (html.match(/<button/g) ?? []).length,
  4,
  "有值的行才给「点击复制」按钮",
);
assert.ok(html.includes("已复制") || html.includes("复制"), "复制按钮要有文案");

// ---- 5) 无组织时渲染成不可点击的占位 ----
const htmlNoOrg = renderToStaticMarkup(
  React.createElement(TaskIdsBar, {
    task: { ...task, agentId: undefined, title: "", createdAt: "", status: "active", workspace: "", provider: "cursor", taskType: "general" },
  }),
);
assert.ok(htmlNoOrg.includes(NO_ORG_PLACEHOLDER), "没有部门时显示占位文案");
assert.ok(htmlNoOrg.includes("is-missing"), "占位行标记成 is-missing");
assert.equal(
  (htmlNoOrg.match(/<button/g) ?? []).length,
  2,
  "只有 Task / Project 可以复制（组织是缺失状态）",
);

console.log("test-task-ids-bar: ok");
