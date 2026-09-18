/**
 * 上下文徽标文案（`web/src/context-format.ts`）检查。
 *
 * 口径纪律：
 * - `tokens` = 当前会话请求体量（最近一次模型调用的 prompt），**不是** usage 累加值；
 * - 窗口未知 / provider 不可用（cursor）时如实显示「未知 / —」，不猜数；
 * - 70% 变黄、85% 红、≥100% 标 over（pdf-reader 实测 104.6%）。
 *
 *   npx tsx web/scripts/test-context-format.mjs
 */
import assert from "node:assert/strict";
import { contextView, forkAckKey, needsForkPrompt } from "../src/context-format.ts";

const run = (over = {}) => ({
  runId: "run-0001",
  at: "2026-09-18T10:00:00.000Z",
  calls: 3,
  startTokens: 900_000,
  endTokens: 960_000,
  growthTokens: 60_000,
  reset: false,
  ...over,
});
const ctx = (over = {}) => ({
  provider: "cline",
  available: true,
  thresholds: { warn: 70, alert: 85 },
  runs: [],
  ...over,
});

// 1) 正常态（本条 task 的真实数：39.1%）
const ok = contextView(
  ctx({
    model: "deepseek-v4-flash",
    limit: 1_000_000,
    tokens: 390_645,
    percent: 39.1,
    sampledAt: "2026-09-18T11:25:00.000Z",
    avgGrowthTokens: 15_908,
    estimatedRunsLeft: 28,
    runs: [run()],
  }),
);
assert.equal(ok.hasData, true);
assert.equal(ok.percentLabel, "39.1%");
assert.equal(ok.tone, "ok");
assert.equal(ok.tokensLabel, "390.6K / 1.00M");
assert.equal(ok.runsLeftLabel, "约 28 轮后到 85%");
assert.match(ok.title, /最近一次模型调用的 prompt/);
assert.match(ok.title, /不是 usage 累加值/);
assert.match(ok.title, /预警线 70% \/ 建议 fork 85%/);

// 2) 阈值着色（含 pdf-reader 的 104.6%）
assert.equal(contextView(ctx({ tokens: 700_000, percent: 70 })).tone, "warn");
assert.equal(contextView(ctx({ tokens: 850_000, percent: 85 })).tone, "alert");
assert.equal(contextView(ctx({ tokens: 1_046_240, percent: 104.6 })).tone, "over");
assert.equal(contextView(ctx({ tokens: 1_046_240, percent: 104.6 })).percentLabel, "104.6%");

// 3) provider 推不出体量（cursor）→ 未知 + 原因
const unknown = contextView({
  provider: "cursor",
  available: false,
  note: "cursor 的 usage 是 agent 累计值，推不出单次请求体量",
  runs: [],
  thresholds: { warn: 70, alert: 85 },
});
assert.equal(unknown.hasData, false);
assert.equal(unknown.percentLabel, "未知");
assert.equal(unknown.tokensLabel, "—");
assert.equal(unknown.tone, "unknown");
assert.match(unknown.title, /agent 累计值/);
assert.match(unknown.title, /不做估算/);

// 4) 没有 context 字段
const none = contextView(undefined);
assert.equal(none.hasData, false);
assert.equal(none.percentLabel, "—");
assert.equal(none.tokensLabel, "无数据");
assert.match(none.title, /还没有可用的上下文采样/);

// 5) 窗口未知：只给 tokens，不给百分比；柱高相对最大值、0 增量也留最小高度、换会话打标
const bars = contextView(
  ctx({
    tokens: 500_000,
    runs: [
      run({ runId: "a", growthTokens: 100_000 }),
      run({ runId: "b", growthTokens: 50_000, reset: true }),
      run({ runId: "c", growthTokens: 0 }),
    ],
  }),
);
assert.equal(bars.hasData, true);
assert.equal(bars.percentLabel, "—");
assert.equal(bars.tone, "unknown", "窗口未知 → 不给百分比，也就不该有阈值颜色");
assert.equal(bars.tokensLabel, "500.0K");
assert.deepEqual(bars.bars.map((b) => b.heightPct), [100, 50, 6]);
assert.deepEqual(bars.bars.map((b) => b.reset), [false, true, false]);
assert.match(bars.bars[1].title, /换了会话/);
assert.match(bars.bars[0].title, /900\.0K → 960\.0K/);
assert.equal(bars.runsLeftLabel, undefined, "没有窗口/增速就不给剩余轮数");

// 6) fork 动线：≥85% 才提示；"不再提醒"按 task 记
const at70 = contextView(ctx({ tokens: 700_000, percent: 70, limit: 1_000_000 }));
const at85 = contextView(ctx({ tokens: 850_000, percent: 85, limit: 1_000_000 }));
assert.equal(at70.needsFork, false, "70% 只是黄灯");
assert.equal(at85.needsFork, true, "85% 起要给 fork 出口");
assert.match(at85.forkHint, /建议 Fork 新 task/);
assert.match(at85.forkHint, /无法再发言/);
assert.equal(needsForkPrompt(at85, false), true);
assert.equal(needsForkPrompt(at85, true), false, "用户选了「不再提醒」就别再弹");
assert.equal(needsForkPrompt(at70, false), false);
assert.equal(
  needsForkPrompt(contextView({ provider: "cursor", available: false, runs: [], thresholds: { warn: 70, alert: 85 } }), false),
  false,
  "推不出体量就不该弹"
);
assert.equal(forkAckKey("task-abc"), "web-cursor:fork-ack:task-abc");

console.log("PASS: context 徽标（百分比 / 阈值着色 / 未知不猜数 / 每轮增量柱 / fork 提示）");
