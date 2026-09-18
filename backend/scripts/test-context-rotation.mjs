/**
 * 自动轮转兜底（PR-4）单测。
 *
 * 分层（见 `backend/src/context/README.md`）：
 *   85% = 给用户的提示（建议 fork，自己决定）；
 *   88% = 系统兜底（换会话，保证"什么都不点也不会卡死"）；
 *   上一次就超限 = 无条件轮转（否则再发一句只会再失败一次，不可逆）。
 *
 * Usage: npx tsx backend/scripts/test-context-rotation.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import {
  CONTEXT_ROTATE_PERCENT,
  CONTEXT_ROTATE_RESERVE_TOKENS,
  shouldRotateContext,
} from "../src/context/index.ts";
import { agentSuccessionFromEvent } from "../src/gateway/gateway.ts";

const limit = 1_000_000;

assert.equal(CONTEXT_ROTATE_PERCENT, 88);
assert.equal(CONTEXT_ROTATE_RESERVE_TOKENS, 60_000);

// ---- 1) 阈值：85% 只提示，88% 起兜底 ----
assert.equal(shouldRotateContext({ tokens: 700_000, limit }).rotate, false, "70% 不该轮转");
assert.equal(shouldRotateContext({ tokens: 850_000, limit }).rotate, false, "85% 是给用户的提示线");
assert.equal(shouldRotateContext({ tokens: 879_000, limit }).rotate, false);
const at88 = shouldRotateContext({ tokens: 880_000, limit });
assert.equal(at88.rotate, true, "88% 起系统兜底");
assert.equal(at88.reason, "over_threshold");
assert.equal(at88.percent, 88);
assert.equal(at88.triggerTokens, 880_000);

// ---- 2) 本次输入要算进去（贴一大段会提前轮转） ----
assert.equal(shouldRotateContext({ tokens: 800_000, limit, incomingTokens: 90_000 }).rotate, true);
assert.equal(shouldRotateContext({ tokens: 800_000, limit, incomingTokens: 10_000 }).rotate, false);

// ---- 3) 上一次就被顶死 → 无条件轮转（与阈值无关，也不要求知道体量） ----
for (const input of [
  { tokens: 100_000, limit, lastRunOverflow: true },
  { lastRunOverflow: true },
]) {
  const forced = shouldRotateContext(input);
  assert.equal(forced.rotate, true, "上一次超限必须轮转");
  assert.equal(forced.reason, "last_run_overflow");
  assert.match(forced.detail, /上一次/);
}

// ---- 4) 总开关（CONTEXT_AUTO_ROTATE=0） ----
assert.equal(
  shouldRotateContext({ tokens: 999_000, limit, enabled: false }).rotate,
  false,
  "关掉自动轮转后只留 fork 提示",
);

// ---- 5) 不猜：窗口/体量未知就不轮转（cursor 推不出体量，只能靠上面的溢出信号） ----
assert.equal(shouldRotateContext({ limit }).rotate, false);
assert.equal(shouldRotateContext({ tokens: 900_000 }).rotate, false);
assert.equal(shouldRotateContext({ tokens: 900_000, limit: 0 }).rotate, false);

// ---- 6) 自定义线（配置化用） ----
assert.equal(shouldRotateContext({ tokens: 600_000, limit, rotatePercent: 50 }).rotate, true);
assert.equal(
  shouldRotateContext({ tokens: 880_000, limit, reserveTokens: 200_000 }).rotate,
  true,
  "余量变大 → 触发更早（limit - reserve 更小）",
);

// ---- 7) 轮转事件落库：reason 要认 context_rotation ----
const baseEvent = {
  eventId: "evt-r1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "cls-new",
  timestamp: "2026-09-18T10:00:00.000Z",
  eventType: "agent_succession",
  payload: {
    provider: "cline",
    fromAgentId: "cls-old",
    toAgentId: "cls-new",
    fromMode: "yolo",
    toMode: "yolo",
    seededMessages: 0,
    contextTokens: 880_000,
    contextLimit: 1_000_000,
    contextPercent: 88,
  },
};
const rotated = agentSuccessionFromEvent({ ...baseEvent, payload: { ...baseEvent.payload, reason: "context_rotation" } });
assert.equal(rotated.reason, "context_rotation");
assert.equal(rotated.seededMessages, 0);
assert.equal(rotated.fromAgentId, "cls-old");
assert.equal(
  agentSuccessionFromEvent({ ...baseEvent, payload: { ...baseEvent.payload, reason: "weird" } }).reason,
  "mode_change",
  "未知 reason 保守落 mode_change",
);

console.log("PASS: 自动轮转兜底（85/88 分层 / 本次输入计入 / 溢出无条件 / 开关 / 不猜 / 事件落库）");
