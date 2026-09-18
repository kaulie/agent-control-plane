/**
 * 计费模块（`backend/src/billing/` + `billing_rules` 表）单测。
 *
 * 起点是一次真实对账：SDK 上报的成本合计 ≈ $15，而按 DeepSeek 官方价目表算是 ≈ ¥297
 * （≈$42）—— 差一个数量级。所以价目/时段规则独立成表，钱只按这张表算，
 * SDK 上报值只作对比（`CostInfo.chargedCents`）。
 *
 * 覆盖：种子表、峰谷时段边界（UTC ↔ 北京时间）、计价、命中优先级、写接口校验、
 * Store CRUD、任务统计的双口径。
 *
 * Usage: npx tsx backend/scripts/test-billing.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEEPSEEK_OFFPEAK_WINDOW,
  USD_PER_CNY,
  billingPeriodFor,
  billingTokens,
  buildBilledCost,
  matchBillingRule,
  normalizeBillingRuleInput,
  priceWithRule,
  resolveBilledCost,
} from "../src/billing/index.ts";
import { Store, DEFAULT_PROJECT_ID } from "../src/store/db.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-billing-"));
const store = new Store(dir);
const rules = store.listBillingRules();
const byId = (id) => {
  const rule = rules.find((r) => r.ruleId === id);
  assert.ok(rule, `seed rule ${id} missing`);
  return rule;
};
const flash = byId("deepseek-v4-flash");
const pro = byId("deepseek-v4-pro");

// ---- 1) 种子表 ------------------------------------------------------------
assert.equal(rules.length, 3, `seeded ${rules.length} rules`);
assert.equal(flash.provider, "cline");
assert.equal(flash.currency, "CNY");
assert.ok(Math.abs(flash.usdPerUnit - USD_PER_CNY) < 1e-12, "usdPerUnit = USD_PER_CNY");
assert.deepEqual(flash.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
assert.deepEqual(flash.offpeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 });
assert.deepEqual(flash.offpeakWindow, DEEPSEEK_OFFPEAK_WINDOW);
assert.deepEqual(pro.peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 });
assert.deepEqual(pro.offpeak, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 });

// 重开：种子必须幂等，运维改过的行不能被覆盖
store.upsertBillingRule({ ...flash, peak: { ...flash.peak, cacheMiss: 2.5 }, updatedAt: "2026-09-18T00:00:00.000Z" });
const reopened = new Store(dir);
assert.equal(reopened.listBillingRules().length, 3, "re-seed must not duplicate");
assert.equal(
  reopened.getBillingRule("deepseek-v4-flash").peak.cacheMiss,
  2.5,
  "hand-edited price survives restart",
);
reopened.close();
// 恢复被改过的价，后面的计价断言用原始价目
store.upsertBillingRule({ ...flash, updatedAt: "2026-09-18T00:00:00.000Z" });

// ---- 2) 峰谷时段边界（UTC ↔ 北京时间） ------------------------------------
// 空闲时段 = 北京时间 00:30–08:30 = UTC 16:30–00:30
assert.equal(billingPeriodFor(flash, "2026-09-18T16:29:00.000Z"), "peak", "北京 00:29");
assert.equal(billingPeriodFor(flash, "2026-09-18T16:30:00.000Z"), "offpeak", "北京 00:30");
assert.equal(billingPeriodFor(flash, "2026-09-18T02:00:00.000Z"), "peak", "北京 10:00 高峰");
assert.equal(billingPeriodFor(flash, "2026-09-18T00:29:00.000Z"), "offpeak", "北京 08:29");
assert.equal(billingPeriodFor(flash, "2026-09-18T00:30:00.000Z"), "peak", "北京 08:30");
// 周末没有单独规则：同样的钟点同样判
assert.equal(billingPeriodFor(flash, "2026-09-19T16:30:00.000Z"), "offpeak");
// 没有窗口的规则永远高峰；坏时间保守算高峰
assert.equal(billingPeriodFor({ offpeakWindow: null }, "2026-09-18T16:30:00.000Z"), "peak");
assert.equal(billingPeriodFor(flash, "not-a-date"), "peak");

// ---- 3) 计价 --------------------------------------------------------------
const hitOnly = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 };
assert.deepEqual(billingTokens(hitOnly), { cacheHit: 1_000_000, cacheMiss: 0, cacheWrite: 0, output: 0 });
const offPeakHit = priceWithRule(flash, hitOnly, "2026-09-18T16:30:00.000Z", "exact");
assert.equal(offPeakHit.period, "offpeak");
assert.equal(offPeakHit.amount, 0.02, "1M 缓存命中 × ¥0.02（空闲）");
assert.equal(offPeakHit.usdCents, 0.28, "¥0.02 ≈ $0.0028 → 0.28 cents");
const peakHit = priceWithRule(flash, hitOnly, "2026-09-18T02:00:00.000Z", "exact");
assert.equal(peakHit.amount, 0.04, "1M 缓存命中 × ¥0.04（高峰）");
// 未命中输入 = input − 缓存读 − 缓存写
const mixed = { inputTokens: 3_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 0 };
assert.deepEqual(billingTokens(mixed), { cacheHit: 1_000_000, cacheMiss: 1_000_000, cacheWrite: 1_000_000, output: 0 });
// 缓存写没给价 → 按未命中价
assert.equal(priceWithRule(flash, mixed, "2026-09-18T02:00:00.000Z", "exact").amount, 0.04 + 2 + 2);
// pro 高峰：1M 未命中 + 1M 输出 = ¥9 + ¥27
const proPeak = priceWithRule(pro, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "2026-09-18T02:00:00.000Z", "exact");
assert.equal(proPeak.amount, 36);
assert.equal(proPeak.prices.cacheMiss, 9);
assert.equal(proPeak.usdCents, 507.04, `¥36 ≈ $${(36 * USD_PER_CNY).toFixed(4)}`);

// ---- 4) 命中优先级 ---------------------------------------------------------
const pattern = { ...flash, ruleId: "r-pattern", model: "deepseek-v4", updatedAt: flash.updatedAt };
const exact = { ...flash, ruleId: "r-exact", model: "deepseek-v4-flash", updatedAt: flash.updatedAt };
assert.equal(matchBillingRule([pattern, exact], "cline", "deepseek-v4-flash").rule.ruleId, "r-exact", "精确 > 包含");
assert.equal(matchBillingRule([flash, exact], "cline", "deepseek-v4-flash").rule.ruleId, "deepseek-v4-flash", "同分按 ruleId 升序（稳定）");
const shorter = { ...flash, ruleId: "r-short", model: "deepseek", updatedAt: flash.updatedAt };
assert.equal(matchBillingRule([shorter, pattern, exact], "cline", "deepseek-v4-flash").matchedBy, "exact");
assert.equal(matchBillingRule([shorter], "cline", "deepseek-v4-flash").rule.ruleId, "r-short", "包含匹配兜底");
const anyModel = { ...flash, ruleId: "r-any", model: "*", updatedAt: flash.updatedAt };
assert.equal(matchBillingRule([anyModel, exact], "cline", "deepseek-v4-flash").rule.ruleId, "r-exact", "精确 > 通配");
const anyProvider = { ...exact, ruleId: "r-any-provider", provider: "*" };
assert.equal(matchBillingRule([anyProvider, exact], "cline", "deepseek-v4-flash").rule.ruleId, "r-exact", "provider 精确 > 通配");
assert.equal(matchBillingRule([anyModel], "cline", "deepseek-v4-flash").rule.ruleId, "r-any");
assert.equal(matchBillingRule([{ ...flash, enabled: false }], "cline", "deepseek-v4-flash"), undefined, "停用行不命中");
assert.equal(matchBillingRule(rules, "cursor", "composer-1"), undefined, "没规则就没命中");
assert.equal(matchBillingRule(rules, "cline", undefined), undefined, "模型未知且无通配 → 不命中");

// ---- 5) buildBilledCost ----------------------------------------------------
const usage = { inputTokens: 2_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };
const billed = buildBilledCost({
  rules,
  provider: "cline",
  model: "deepseek-v4-flash",
  usage,
  at: "2026-09-18T02:00:00.000Z",
  reported: { chargedCents: 7 },
  fallbackEstimatedCents: 99,
});
assert.equal(billed.billing.ruleId, "deepseek-v4-flash");
assert.equal(billed.billing.period, "peak");
assert.equal(billed.estimatedCents, billed.billing.usdCents, "主口径 = 表算的钱");
assert.equal(billed.estimatedCents, 141.41, `1M 未命中 ¥2 + 1M 命中 ¥0.04 + 1M 输出 ¥8 = ¥10.04 → $10.04/7.1 ≈ $1.4141`);
assert.equal(billed.chargedCents, 7, "SDK 上报值原样保留（对比口径）");
assert.equal(billed.currency, "USD");
assert.equal(billed.billing.amount, 10.04);
assert.equal(billed.billing.currency, "CNY");
assert.equal(
  Object.keys(billed.billing.breakdown).length, 4, "分项：命中 / 未命中 / 缓存写 / 输出"
);

assert.equal(buildBilledCost({ rules, provider: "cline", model: "m", at: "x" }), undefined, "没 usage 也没上报 → 不写 cost");
assert.equal(
  buildBilledCost({ rules, provider: "cursor", model: "composer-1", usage, at: "x" }),
  undefined,
  "没规则命中且没有可保留的值 → 不写 cost",
);
// 没命中规则 → 实际成本 = 上报值（两个口径一样）；旧估算只在连上报值都没有时用
const noRule = buildBilledCost({
  rules,
  provider: "cursor",
  model: "composer-1",
  usage,
  at: "x",
  reported: { chargedCents: 3 },
  fallbackEstimatedCents: 5.5,
});
assert.equal(noRule.estimatedCents, 3, "没规则 → 实际成本 = SDK 上报值");
assert.equal(noRule.estimatedCents, noRule.chargedCents, "没规则时两个口径必须同值");
assert.equal(noRule.costSource, "reported");
assert.equal(noRule.billing, undefined);
const estimateOnly = buildBilledCost({
  rules,
  provider: "cursor",
  model: "composer-1",
  usage,
  at: "x",
  fallbackEstimatedCents: 5.5,
});
assert.equal(estimateOnly.estimatedCents, 5.5, "连上报值都没有 → 才用旧估算");
assert.equal(estimateOnly.costSource, "estimate");
assert.equal(billed.costSource, "rule", "命中规则 → rule");

// 读取端（Store 统计 / 重算脚本）与写入端共用同一个取值函数
assert.deepEqual(resolveBilledCost(billed), { cents: billed.billing.usdCents, source: "rule" });
assert.deepEqual(resolveBilledCost(noRule), { cents: 3, source: "reported" });
assert.deepEqual(resolveBilledCost(estimateOnly), { cents: 5.5, source: "estimate" });
assert.deepEqual(resolveBilledCost({ currency: "USD", rawCostCents: 4 }), { cents: 4, source: "reported" });
assert.equal(resolveBilledCost({ currency: "USD" }), undefined);
assert.equal(resolveBilledCost(undefined), undefined);

// ---- 6) 写接口校验 ---------------------------------------------------------
const custom = normalizeBillingRuleInput("my-model", {
  provider: " cline ",
  model: " deepseek-v4-x ",
  currency: "CNY",
  usdPerUnit: USD_PER_CNY,
  peak: { cacheHit: 0.1, cacheMiss: 1, output: 2 },
  offpeak: { cacheHit: 0.05, cacheMiss: 0.5, output: 1 },
  offpeakWindow: { startMinute: 990, endMinute: 30 },
  enabled: true,
});
assert.equal(custom.provider, "cline", "trim");
assert.equal(custom.priority, 0);
assert.deepEqual(custom.offpeakWindow, { startMinute: 990, endMinute: 30 });
assert.throws(() => normalizeBillingRuleInput("x", { model: "m", peak: { cacheHit: 0, cacheMiss: 0, output: 0 } }), /provider 必填/);
assert.throws(() => normalizeBillingRuleInput("x", { provider: "cline", model: "m", peak: { cacheHit: 0, cacheMiss: 0, output: 0 }, offpeakWindow: { startMinute: 1440, endMinute: 0 } }), /startMinute 不能大于 1439/);
assert.throws(() => normalizeBillingRuleInput("x", { provider: "cline", model: "m", peak: { cacheHit: -1, cacheMiss: 0, output: 0 } }), /cacheHit 不能小于 0/);
assert.throws(() => normalizeBillingRuleInput("x", { provider: "cline", model: "m", peak: { cacheHit: 0, cacheMiss: 0, output: 0 }, offpeakWindow: { startMinute: 0, endMinute: 60 } }), /offpeak 必须是对象/);
// 没有窗口时 offpeak 缺省跟随 peak（不会静默算 0）
const noWindow = normalizeBillingRuleInput("y", { provider: "cline", model: "m", peak: { cacheHit: 1, cacheMiss: 2, output: 3 } });
assert.deepEqual(noWindow.offpeak, { cacheHit: 1, cacheMiss: 2, output: 3 });
assert.equal(noWindow.offpeakWindow, null);

// ---- 7) Store CRUD --------------------------------------------------------
store.upsertBillingRule(custom);
assert.equal(store.listBillingRules().length, 4);
const stored = store.getBillingRule("my-model");
assert.equal(stored.model, "deepseek-v4-x");
assert.deepEqual(stored.peak, { cacheHit: 0.1, cacheMiss: 1, output: 2 });
store.upsertBillingRule({ ...custom, priority: 5 });
assert.equal(store.listBillingRules().length, 4, "upsert 不重复插入");
assert.equal(store.getBillingRule("my-model").priority, 5);
assert.equal(store.deleteBillingRule("my-model"), true);
assert.equal(store.deleteBillingRule("my-model"), false);
assert.equal(store.listBillingRules().length, 3);

// ---- 8) 任务统计：两个口径分开 ---------------------------------------------
const task = store.createTask({
  title: "billing-stats",
  workspace: path.join(dir, "ws"),
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: DEFAULT_PROJECT_ID,
});
const withTable = store.createRun({ runId: "run-1", taskId: task.taskId, agentId: "cls-1", provider: "cline", model: "deepseek-v4-flash" });
assert.ok(withTable.runId);
store.updateRun("run-1", {
  status: "finished",
  usage,
  cost: buildBilledCost({
    rules,
    provider: "cline",
    model: "deepseek-v4-flash",
    usage,
    at: "2026-09-18T02:00:00.000Z",
    reported: { chargedCents: 7 },
    fallbackEstimatedCents: 99,
  }),
});
// 老 run：只有 SDK 上报值（没有计费表明细）→ 主口径退回上报值
store.createRun({ runId: "run-2", taskId: task.taskId, agentId: "cls-1", provider: "cline", model: "deepseek-v4-flash" });
store.updateRun("run-2", { status: "finished", usage, cost: { chargedCents: 3, estimatedCents: 5, currency: "USD" } });

const stats = store.getTaskStats(task.taskId);
assert.equal(stats.costCents, Math.round((billed.estimatedCents + 3) * 100) / 100, "主口径 = 表算的 + 没规则那轮的上报值");
assert.equal(stats.billedAmount, billed.billing.amount, "本币金额只累计命中规则的 run");
assert.equal(stats.billedCurrency, "CNY");
assert.equal(stats.chargedCents, 10, "SDK 上报 = 7 + 3（对比口径，独立）");
assert.deepEqual(stats.costSources, { rule: 1, reported: 1, estimate: 0 });

// 全是「没规则」的任务（例如 cursor）：两个口径必须同值
const cursorTask = store.createTask({
  title: "cursor-only",
  workspace: path.join(dir, "ws2"),
  provider: "cursor",
  model: "composer-1",
  projectId: DEFAULT_PROJECT_ID,
});
store.createRun({ runId: "run-c", taskId: cursorTask.taskId, agentId: "agent-1", provider: "cursor", model: "composer-1" });
store.updateRun("run-c", {
  status: "finished",
  usage,
  cost: buildBilledCost({
    rules,
    provider: "cursor",
    model: "composer-1",
    usage,
    at: "2026-09-18T02:00:00.000Z",
    reported: { chargedCents: 42 },
    fallbackEstimatedCents: 999,
  }),
});
const cursorStats = store.getTaskStats(cursorTask.taskId);
assert.equal(cursorStats.costCents, 42, "没规则 → 实际成本 = 上报值");
assert.equal(cursorStats.chargedCents, cursorStats.costCents, "没规则时两个口径同值");
assert.equal(cursorStats.billedAmount, undefined, "没有计费表明细 → 不给本币金额");
assert.deepEqual(cursorStats.costSources, { rule: 0, reported: 1, estimate: 0 });

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: billing rules table + module (prices, periods, matching, cost 顺序 rule > reported > estimate)");
