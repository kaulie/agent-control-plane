/**
 * 主界面「当前 agent 已执行轮次」(`web/src/agent-rounds.ts` +
 * `web/src/components/AgentRoundsBar.tsx`) 的前端单测。
 *
 * 口径必须是**当前 agent 自己**的轮次（run 数），不是整条 task 的累计：
 * - succession 换过 agent 时，只数绑定在当前 agent 上的 run；
 * - 「已执行」= 真正跑过（不含还在排队的 queued）；
 * - 老任务没有 agentId → 退回最后一轮 run 的 agent，都没有就整条不渲染。
 *
 *   npx tsx --tsconfig web/tsconfig.json web/scripts/test-agent-rounds.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const {
  currentAgentRounds,
  resolveCurrentAgentId,
  roundsLabel,
  roundsTitle,
} = await import("../src/agent-rounds.ts");
const { default: AgentRoundsBar } = await import(
  "../src/components/AgentRoundsBar.tsx"
);

/** 构造一条 run（只填这几处口径用到的字段）。 */
const run = (agentId, status) => ({
  runId: `${agentId}-${status}-${Math.random().toString(36).slice(2, 7)}`,
  taskId: "task-1",
  agentId,
  provider: "cline",
  status,
  createdAt: "2026-09-20T00:00:00.000Z",
  modelCalls: 0,
  toolCalls: 0,
});

// ---- 1) 只数当前 agent 自己的 run，跨 agent 的不算 ----
const runs = [
  run("agent-old", "finished"),
  run("agent-old", "finished"),
  run("agent-cur", "finished"),
  run("agent-cur", "finished"),
  run("agent-cur", "running"),
  run("agent-cur", "error"),
  run("agent-cur", "cancelled"),
  run("agent-cur", "queued"),
];
const cur = currentAgentRounds(runs, "agent-cur");
assert.equal(cur.total, 6, "只数 agent-cur 自己的 6 条 run（含 queued）");
assert.equal(cur.executed, 5, "已执行 = 6 - 1 个 queued");
assert.equal(cur.finished, 2);
assert.equal(cur.running, 1);
assert.equal(cur.failed, 2, "error + cancelled 都算跑过但没成功");
assert.equal(cur.queued, 1);

// 换一个 agent 看数字确实跟着变（口径是 per-agent）。
const old = currentAgentRounds(runs, "agent-old");
assert.equal(old.executed, 2);
assert.equal(old.finished, 2);
assert.equal(old.running, 0);

// ---- 2) 陌生 agent / 空 id：全 0，不炸 ----
const none = currentAgentRounds(runs, "agent-unknown");
assert.deepEqual(
  [none.total, none.executed, none.finished, none.running, none.failed, none.queued],
  [0, 0, 0, 0, 0, 0],
);
const empty = currentAgentRounds(runs, "");
assert.equal(empty.executed, 0);
assert.equal(empty.total, 0, "空 id 不会把所有 run 都算进来");

// ---- 3) resolveCurrentAgentId：task.agentId 优先，老任务退回最后一轮 run ----
assert.equal(resolveCurrentAgentId("agent-cur", runs), "agent-cur");
assert.equal(resolveCurrentAgentId("  agent-cur  ", runs), "agent-cur", "trim");
assert.equal(
  resolveCurrentAgentId(undefined, runs),
  "agent-cur",
  "老任务没有 agentId → 用最后一轮 run 的 agent",
);
assert.equal(resolveCurrentAgentId("", []), "", "什么都没有 → 空串");

// ---- 4) 文案：主数字写「已执行 N 轮」，title 写清口径 ----
assert.equal(roundsLabel(cur), "已执行 5 轮");
const title = roundsTitle(cur);
assert.ok(title.includes("当前 agent（agent-cur）"), title);
assert.ok(title.includes("5 轮"), title);
assert.ok(title.includes("排队 1"), title);
assert.ok(title.includes("task 累计"), "title 要提醒这是 per-agent 口径");

// ---- 5) 渲染：当前 agent 的轮次数就在页面上，旧 agent 不算进去 ----
const html = renderToStaticMarkup(
  React.createElement(AgentRoundsBar, { runs, agentId: "agent-cur" }),
);
assert.ok(html.includes("agent-rounds"), "渲染出 agent-rounds 容器");
assert.ok(html.includes("当前 agent 已执行"), html);
assert.ok(html.includes('data-agent-id="agent-cur"'));
// 主数字是 5（不是 task 的 8）—— 用它自己的 chip 数字校验。
const count = html.match(/agent-rounds-count[^>]*>(\d+)</);
assert.ok(count, "有主数字节点");
assert.equal(count[1], "5", "页面上的数字必须是当前 agent 的已执行轮次");
assert.ok(html.includes("完成 2 · 在跑 1"), "明细行给出完成 / 在跑");

// 最后那一轮 run 是 agent-cur → 老任务（无 agentId）也能渲染出来
const legacyHtml = renderToStaticMarkup(
  React.createElement(AgentRoundsBar, { runs, agentId: undefined }),
);
assert.ok(legacyHtml.includes('data-agent-id="agent-cur"'));

// ---- 6) 没有 agent 实例 → 整条不渲染（null）----
const emptyHtml = renderToStaticMarkup(
  React.createElement(AgentRoundsBar, { runs: [], agentId: undefined }),
);
assert.equal(emptyHtml, "", "没有 agent 就什么都不显示");

console.log("PASS: 当前 agent 已执行轮次（per-agent 口径 + 渲染）");
