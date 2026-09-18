/**
 * UsageBar 两个「钱」的文案检查（`web/src/usage-cost.ts` + `format.ts`）。
 *
 * 实际成本的取值顺序是 **计费表 > provider/SDK 上报 > 旧估算**：
 * - 命中 `billing_rules` 的 run（cline / DeepSeek）：两个格子**不同** ——
 *   Cost = 表算出来的本币（≈ ¥297 / ≈$42），SDK cost = 上报值（≈ $15）；
 * - 没有规则的 run（cursor / 未入库的模型）：实际成本**就是上报值**，两个格子显示同一个数；
 * - 两个格子都要显示出来（不再出现「—」）。
 *
 *   npx tsx web/scripts/test-usage-cost.mjs
 */
import assert from "node:assert/strict";
import { formatMoney } from "../src/format.ts";
import { usageCostView } from "../src/usage-cost.ts";

/** 任务统计的最小形状（只填这几处文案用到的字段）。 */
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

// 1) 命中计费表：两个口径不同，分开显示、不要相加
const ruled = usageCostView(
  stats({
    costCents: 4187.32,
    billedAmount: 297.26,
    billedCurrency: "CNY",
    chargedCents: 1496,
    costSources: { rule: 3, reported: 0, estimate: 0 },
  }),
);
assert.equal(ruled.billed, "¥297.26");
assert.equal(ruled.sdk, "$14.96");
assert.equal(ruled.same, false);
assert.match(ruled.billedTitle, /billing_rules/);
assert.match(ruled.billedTitle, /本币 CNY/);
assert.match(ruled.billedTitle, /≈ \$41\.87/);
assert.match(ruled.sdkTitle, /不要相加/);

// 2) 没有规则（cursor 等）：实际成本 = 上报值 → 两个格子同值，且都显示出来
const noRule = usageCostView(
  stats({
    costCents: 150,
    chargedCents: 150,
    costSources: { rule: 0, reported: 1, estimate: 0 },
  }),
);
assert.equal(noRule.billed, "$1.50");
assert.equal(noRule.sdk, "$1.50");
assert.equal(noRule.same, true);
assert.match(noRule.billedTitle, /上报值/);
assert.match(noRule.sdkTitle, /同一个数/);
assert.doesNotMatch(noRule.sdk, /—/, "两个格子都要有值");

// 3) 混合（有规则 + 没规则）也照常显示两个数
const mixed = usageCostView(
  stats({
    costCents: 200,
    billedAmount: 12.5,
    billedCurrency: "CNY",
    chargedCents: 7,
    costSources: { rule: 2, reported: 1, estimate: 0 },
  }),
);
assert.equal(mixed.billed, "¥12.50");
assert.equal(mixed.sdk, "$0.07");
assert.match(mixed.billedTitle, /另有 1 轮/);

// 4) 连上报值都没有 → 两个格子显示同一个（本币）值，不出现破折号
const tableOnly = usageCostView(stats({ billedAmount: 12.5, billedCurrency: "CNY" }));
assert.equal(tableOnly.billed, "¥12.50");
assert.equal(tableOnly.sdk, "¥12.50");
assert.equal(tableOnly.same, true);

// 4b) cursor 现状：没规则、SDK 也不返回成本 → 旧估算兜底，两个格子同值，title 说清原因
const cursorLike = usageCostView(
  stats({ costCents: 82590, costSources: { rule: 0, reported: 0, estimate: 786 } }),
);
assert.equal(cursorLike.billed, "$825.90");
assert.equal(cursorLike.sdk, "$825.90");
assert.equal(cursorLike.same, true);
assert.match(cursorLike.billedTitle, /旧本地估算/);
assert.match(cursorLike.billedTitle, /SDK 也没返回成本/);

// 5) 币种 / 极小金额
assert.equal(formatMoney(0.004, "CNY"), "¥0.0040");
assert.equal(formatMoney(0.02, "CNY"), "¥0.02");
assert.equal(formatMoney(12.3, "CHF"), "CHF 12.30");
assert.equal(formatMoney(undefined, "CNY"), "¥0.00");
assert.equal(formatMoney(3.5), "$3.50");

console.log("PASS: UsageBar 两个成本口径都显示（有规则时分开、没规则时同值）");
