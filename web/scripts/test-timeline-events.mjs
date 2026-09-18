/**
 * 时间线「透明化文案」检查（`web/src/components/Timeline.tsx` 的 `buildRows`）。
 *
 * 背景：系统里有一批**改变 agent 记忆/上下文**的动作，以前都是无感的（网关重启把会话重置、
 * 切模式把 ≈1M 上下文搬进新会话、启动简报被 7,500 字符从头截断……）。按约定它们必须
 * 在时间线上**明确写出来**，这个测试守住这几行文案。
 *
 *   npx tsx web/scripts/test-timeline-events.mjs
 */
import assert from "node:assert/strict";
import { buildRows } from "../src/components/Timeline.tsx";

const ev = (eventType, payload, over = {}) => ({
  eventId: `evt-${eventType}`,
  taskId: "task-1",
  runId: "run-1",
  agentId: "cls-1",
  timestamp: "2026-09-18T10:00:00.000Z",
  eventType,
  payload,
  ...over,
});

// 1) 网关重启 / 会话失效 → 必须显式说"会话已重置"（以前完全无感）
const reset = buildRows([
  ev("status", {
    status: "session_reset",
    message: "之前绑定的会话 cls-abc 不在本进程中（网关重启或会话失效）…",
    previousAgentId: "cls-abc",
  }),
])[0];
assert.equal(reset.body, "会话已重置");
assert.match(reset.detail, /网关重启/);

// 2) 其它 status 不受影响
assert.equal(buildRows([ev("status", { status: "working", message: "x" })])[0].body, "仍在执行");
assert.equal(buildRows([ev("status", { status: "retrying" })])[0].body, "自动重试");

// 3) succession 要同时给出条数与 token 体量（pdf-reader 那次：1630 条 ≈ 1.02M）
const succession = buildRows([
  ev("agent_succession", {
    fromAgentId: "cls-0123456789abcdef",
    toAgentId: "cls-fedcba9876543210",
    fromMode: "yolo",
    toMode: "plan",
    reason: "mode_change",
    seededMessages: 1630,
    seededTokens: 1024000,
  }),
])[0];
assert.match(succession.detail, /seeded 1630 msgs/);
assert.match(succession.detail, /≈ 1\.02M tokens/);
assert.match(succession.body, /→/);

// 4) 新开会话的 run_started 要带简报体量；被裁剪时写清楚丢了什么
const withBootstrap = buildRows([
  ev("run_started", {
    cwd: "/tmp/ws",
    model: "deepseek-v4-flash",
    sessionCreated: true,
    bootstrapChars: 7500,
    bootstrapTruncated: true,
    bootstrapKeptUserMessages: 12,
    bootstrapDroppedUserMessages: 8,
    bootstrapKeptRunResults: 6,
    bootstrapDroppedRunResults: 4,
  }),
])[0];
assert.equal(withBootstrap.body, "deepseek-v4-flash");
assert.match(withBootstrap.detail, /简报 7\.5K 字符/);
assert.match(withBootstrap.detail, /丢 8 条用户消息 \/ 4 条 run 结论/);

// 5) 没带简报（老事件 / 常驻会话）就只显示 cwd
const plain = buildRows([ev("run_started", { cwd: "/tmp/ws", model: "m" })])[0];
assert.equal(plain.detail, "/tmp/ws");

console.log("PASS: 时间线透明化文案（会话重置 / seed 体量 / 简报裁剪）");
