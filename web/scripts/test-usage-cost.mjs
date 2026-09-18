/**
 * UsageBar 两个「钱」的文案检查（`web/src/usage-cost.ts` + `format.ts`）。
 *
 * 起点是对账结论：库里有两个成本口径，差一个数量级 ——
 *   计费表（`billing_rules`，DeepSeek 官方价目）≈ ¥297 / ≈$42；
 *   SDK 自己上报的 totalCost ≈ $15（价卡不同）。
 * 所以页面上必须**分开显示**，且不能相加；缺计费表明细时退回美元口径。
 *
 *   npx tsx web/scripts/test-usage-cost.mjs
 */
import assert from "node:assert/strict";
import { formatMoney } from "../src/format.ts";
import { usageCostView } from "../src/usage-cost.ts";

/** 任务统计的最小形状（只填这两处文案用到的字段）。 */
const stats = (over = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  currency: "USD",
  durationMs: 0,
  modelCalls: 0,
  toolCalls: 0,
  runCount: 0,
  ...over,
});

// 1) 两个口径分开显示：表口径用本币，SDK 上报值单独一格
const both = usageCostView(
  stats({ costCents: 4187.32, billedAmount: 297.26, billedCurrency: "CNY", chargedCents: 1496 }),
);
assert.equal(both.billed, "¥297.26");
assert.equal(both.sdk, "$14.96");
assert.notEqual(both.billed, both.sdk);
assert.match(both.billedTitle, /billing_rules/);
assert.match(both.billedTitle, /本币 CNY/);
assert.match(both.billedTitle, /≈ \$41\.87/);
assert.match(both.sdkTitle, /上报/);

// 2) 没有计费表明细（历史 run / 没规则命中）→ 退回美元口径，SDK 值仍独立显示
const legacy = usageCostView(stats({ estimatedCents: 5, chargedCents: 3 }));
assert.equal(legacy.billed, "$0.05");
assert.equal(legacy.sdk, "$0.03");

// 3) 没有 SDK 上报值 → 破折号，不要显示 $0.00 冒充「免费」
const tableOnly = usageCostView(stats({ billedAmount: 12.5, billedCurrency: "CNY" }));
assert.equal(tableOnly.billed, "¥12.50");
assert.equal(tableOnly.sdk, "—");

// 4) 单轮金额很小（< 0.01 元）时保留 4 位，别显示成 ¥0.00
assert.equal(formatMoney(0.004, "CNY"), "¥0.0040");
assert.equal(formatMoney(0.02, "CNY"), "¥0.02");
assert.equal(formatMoney(12.3, "CHF"), "CHF 12.30");
assert.equal(formatMoney(undefined, "CNY"), "¥0.00");
assert.equal(formatMoney(3.5), "$3.50");

console.log("PASS: UsageBar 显示两个成本口径（计费表本币 / SDK 上报美元），互不相加");
