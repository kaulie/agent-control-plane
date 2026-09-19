/**
 * 任务意图（类型标签 + 系统投递消息）前端单测：
 *
 * - 类型目录口径（4 项、label 唯一、general 是默认且**没有**模板/引导 → 老行为不变）；
 * - `buildRows` 把「系统投递的需求」渲染成系统卡片（不再显示成用户自己打的），
 *   而普通用户消息完全不受影响。
 *
 *   npx tsx web/scripts/test-task-intent-ui.mjs
 */
import assert from "node:assert/strict";
import { buildRows } from "../src/components/Timeline.tsx";
import {
  DEFAULT_TASK_TYPE,
  TASK_TYPE_OPTIONS,
  normalizeTaskType,
  taskTypeLabel,
  taskTypeOption,
} from "../src/task-types.ts";

// ---- 1) 类型目录 ----
assert.equal(TASK_TYPE_OPTIONS.length, 4);
assert.deepEqual(
  TASK_TYPE_OPTIONS.map((o) => o.id),
  ["feature", "bugfix", "diagnose", "general"],
);
const labels = TASK_TYPE_OPTIONS.map((o) => o.label);
assert.equal(new Set(labels).size, labels.length, "label 不能重复");
const shorts = TASK_TYPE_OPTIONS.map((o) => o.short);
assert.equal(new Set(shorts).size, shorts.length, "徽标短标签不能重复");
for (const option of TASK_TYPE_OPTIONS) {
  assert.ok(option.placeholder.trim(), `${option.id} 要有 placeholder 引导`);
  assert.ok(option.hint.trim(), `${option.id} 要有说明`);
}
const general = taskTypeOption("general");
assert.equal(general.template, undefined, "general 不给模板（= 老流程不变）");
for (const id of ["feature", "bugfix", "diagnose"]) {
  assert.ok(taskTypeOption(id).template, `${id} 应该有可插入的描述模板`);
}

// 未知 / 空值回落 general（历史任务的值）
assert.equal(normalizeTaskType(undefined), DEFAULT_TASK_TYPE);
assert.equal(normalizeTaskType("refactor"), DEFAULT_TASK_TYPE);
assert.equal(normalizeTaskType("bugfix"), "bugfix");
assert.equal(taskTypeLabel(undefined), "通用");
assert.equal(taskTypeLabel("diagnose"), "问题定位");

// ---- 2) 系统投递消息渲染成系统卡片 ----
const ev = (eventType, payload, over = {}) => ({
  eventId: `evt-${eventType}`,
  taskId: "task-1",
  runId: "run-1",
  agentId: "cls-1",
  timestamp: "2026-09-19T10:00:00.000Z",
  eventType,
  payload,
  ...over,
});

const delivered = buildRows([
  ev("user_message", {
    text: "【需求投递】导出 CSV 少一列\n类型：缺陷修复（bugfix）\n\n描述：\n最后一列缺失",
    mode: "agent",
    deliveredBy: "system",
    kind: "task_intent",
  }),
])[0];
assert.equal(delivered.label, "系统投递 · 需求");
assert.equal(delivered.icon, "⚙️");
assert.equal(delivered.deliveredBySystem, true);
assert.match(delivered.body, /【需求投递】/);

// 人打的用户消息照旧
const human = buildRows([
  ev("user_message", { text: "继续", mode: "agent" }),
])[0];
assert.equal(human.label, "You");
assert.notEqual(human.deliveredBySystem, true);

// 系统投递但还没跑完时仍显示排队标记
const queued = buildRows([
  ev("user_message", {
    text: "【需求投递】x",
    deliveredBy: "system",
    kind: "task_intent",
    queued: true,
  }),
])[0];
assert.equal(queued.queued, true);

console.log("✅ task-intent UI OK");
