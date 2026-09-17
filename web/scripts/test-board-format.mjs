/**
 * 看板「数字口径」文案检查（`web/src/board-format.ts`）。
 *
 * 起点是一个真实的抱怨：`token-tune` 那一行显示「累计只完成两轮 run」。数字本身没错
 * —— 那是 succession 之后**当前那个 agent** 自己的 run 数，而这个 task 历史上换过 7 个
 * agent，合计 38 轮。所以页面上必须同时给出两个口径：
 *   - 这一行（agent）：完成 N 轮 / 共 M runs；
 *   - 整个 task：`task 累计 X 轮（K 个 agent）`。
 *
 *   npx tsx web/scripts/test-board-format.mjs
 */
import assert from "node:assert/strict";
import { roundsTitle, taskRollupText } from "../src/board-format.ts";

/** 一个 agent 行的最小形状（只填这两处文案用到的字段）。 */
const agentRow = (over = {}) => ({
  agentId: "cls-1234567890abcdef",
  agentName: "cls-12345678",
  provider: "cline",
  projectId: "project-1",
  projectName: "autonomy",
  taskId: "task-1",
  taskTitle: "token-tune",
  taskStatus: "active",
  taskCreatedAt: "2026-09-16T11:05:58.299Z",
  taskWorkspace: "/tmp/task-1",
  current: true,
  running: false,
  tokens: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  },
  durationMs: 0,
  runCount: 6,
  completedRounds: 5,
  modelCalls: 78,
  toolCalls: 73,
  ...over,
});

// 1) task 换过多个 agent：行里补出 task 口径（这就是那次抱怨缺的那句话）。
const widened = agentRow({
  taskTotals: {
    completedRounds: 38,
    runCount: 39,
    totalTokens: 350_894_261,
    durationMs: 6_613_250,
    modelCalls: 959,
    toolCalls: 1096,
    agentCount: 7,
  },
});
assert.equal(taskRollupText(widened), "task 累计 38 轮（7 个 agent）");
const title = roundsTitle(widened);
assert.ok(title.includes("这个 agent 完成 5 轮"), title);
assert.ok(title.includes("共 6 次 run"), title);
assert.ok(title.includes("task 累计：38 轮 / 39 runs"), title);
assert.ok(title.includes("换过 7 个 agent 实例"), title);

// 2) task 只有一个 agent：两个口径一样，不重复写（少点噪音）。
const single = agentRow({
  taskTotals: {
    completedRounds: 5,
    runCount: 6,
    totalTokens: 0,
    durationMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    agentCount: 1,
  },
});
assert.equal(taskRollupText(single), null);
assert.ok(!roundsTitle(single).includes("task 累计"));

// 3) scope=task 的行：这一行本来就是整个 task，不需要再补。
const taskRow = agentRow({ taskScope: true, agentId: "", agentCount: 7 });
assert.equal(taskRollupText(taskRow), null);
assert.ok(roundsTitle(taskRow).startsWith("整个 task 累计完成 5 轮"));

// 4) 老响应（没有 taskTotals）不炸。
const legacy = agentRow();
assert.equal(taskRollupText(legacy), null);
assert.ok(!roundsTitle(legacy).includes("task 累计"));

console.log("PASS: board number wording (agent scope + whole-task scope)");
