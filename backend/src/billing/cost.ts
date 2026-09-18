import type { CostInfo, TokenUsage } from "../types.js";
import { billingPeriodFor, matchBillingRule } from "./rules.js";
import type {
  BillingCostInfo,
  BillingMatchKind,
  BillingPeriod,
  BillingPrice,
  BillingRule,
  BillingTokenParts,
} from "./types.js";

/**
 * 把 usage 拆成计费要的四个桶。
 * 未命中输入 = `input − cacheRead − cacheWrite`（input 已含缓存，见 usage/tokens.ts）。
 */
export function billingTokens(usage: TokenUsage): BillingTokenParts {
  const input = Number(usage.inputTokens) || 0;
  const cacheHit = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  return {
    cacheHit,
    cacheMiss: Math.max(0, input - cacheHit - cacheWrite),
    cacheWrite,
    output,
  };
}

/** 该时段生效的价目。 */
export function pricesForPeriod(
  rule: BillingRule,
  period: BillingPeriod,
): BillingPrice {
  return period === "offpeak" ? rule.offpeak : rule.peak;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 按一条规则 + 一个时刻，把 usage 算成钱（含明细）。 */
export function priceWithRule(
  rule: BillingRule,
  usage: TokenUsage,
  at: string,
  matchedBy: BillingMatchKind,
): BillingCostInfo {
  const tokens = billingTokens(usage);
  const period = billingPeriodFor(rule, at);
  const prices = pricesForPeriod(rule, period);
  const perMillion = (tokensCount: number, price: number): number =>
    (tokensCount / 1e6) * price;
  const breakdown: BillingTokenParts = {
    cacheHit: perMillion(tokens.cacheHit, prices.cacheHit),
    cacheMiss: perMillion(tokens.cacheMiss, prices.cacheMiss),
    cacheWrite: perMillion(tokens.cacheWrite, prices.cacheWrite ?? prices.cacheMiss),
    output: perMillion(tokens.output, prices.output),
  };
  const amount =
    breakdown.cacheHit +
    breakdown.cacheMiss +
    breakdown.cacheWrite +
    breakdown.output;
  return {
    ruleId: rule.ruleId,
    provider: rule.provider,
    model: rule.model,
    matchedBy,
    period,
    at,
    currency: rule.currency,
    usdPerUnit: rule.usdPerUnit,
    amount: round(amount, 6),
    usdCents: round(amount * rule.usdPerUnit * 100, 2),
    prices,
    tokens,
    breakdown,
    offpeakWindow: rule.offpeakWindow,
  };
}

export interface BuildBilledCostInput {
  rules: readonly BillingRule[];
  provider: string;
  model?: string | null;
  usage?: TokenUsage | null;
  /** 计费基准时刻（run 起始，ISO8601）——时段判定用它。 */
  at: string;
  /** provider / SDK 自己上报的金额；命中规则时只作对比，没规则时就是实际成本。 */
  reported?: { rawCostCents?: number; chargedCents?: number };
  /** 没规则、也没上报值时保留的旧本地估算（兼容历史口径）。 */
  fallbackEstimatedCents?: number;
}

/** 实际成本（`cost_json.estimatedCents`）的来源。 */
export type CostSource = "rule" | "reported" | "estimate";

export interface ResolvedBilledCost {
  cents: number;
  source: CostSource;
}

/**
 * 一个 run 的「实际成本」取值顺序：**计费表 > provider/SDK 上报 > 旧本地估算**。
 *
 * 没有规则命中的 provider / 模型（例如 cursor，价目表还没入库）就落在 `reported`，
 * 也就是说这时**实际成本 = 上报值** —— 页面上「Cost」与「SDK cost」两个格子显示同一个数
 * （见 `web/src/usage-cost.ts`）。
 */
export function resolveBilledCost(
  cost: CostInfo | undefined,
): ResolvedBilledCost | undefined {
  if (!cost) return undefined;
  if (cost.billing) return { cents: cost.billing.usdCents, source: "rule" };
  if (cost.chargedCents != null) return { cents: cost.chargedCents, source: "reported" };
  if (cost.rawCostCents != null) return { cents: cost.rawCostCents, source: "reported" };
  if (cost.estimatedCents != null) return { cents: cost.estimatedCents, source: "estimate" };
  return undefined;
}

/**
 * 产出 `run.cost_json`。`estimatedCents`（= 实际成本）的顺序：
 * - 命中规则 → 按表算出来的钱（USD cents）+ 明细 `billing`，`costSource: "rule"`；
 * - 没命中规则但有上报值 → **就等于上报值**，`costSource: "reported"`（两个口径一样）；
 * - 只有旧估算 → `costSource: "estimate"`；
 * - 什么都没有 → `undefined`（run 不写 cost）。
 */
export function buildBilledCost(
  input: BuildBilledCostInput,
): CostInfo | undefined {
  const reported = input.reported ?? {};
  const base: CostInfo = {
    ...(reported.rawCostCents != null ? { rawCostCents: reported.rawCostCents } : {}),
    ...(reported.chargedCents != null ? { chargedCents: reported.chargedCents } : {}),
    currency: "USD",
    ...(input.model ? { model: input.model } : {}),
  };

  const match = input.usage
    ? matchBillingRule(input.rules, input.provider, input.model)
    : undefined;

  if (!match || !input.usage) {
    const reportedCents = reported.chargedCents ?? reported.rawCostCents;
    if (reportedCents != null) {
      return { ...base, estimatedCents: reportedCents, costSource: "reported" };
    }
    if (input.fallbackEstimatedCents != null) {
      return { ...base, estimatedCents: input.fallbackEstimatedCents, costSource: "estimate" };
    }
    return undefined;
  }

  const billing = priceWithRule(match.rule, input.usage, input.at, match.matchedBy);
  return { ...base, estimatedCents: billing.usdCents, costSource: "rule", billing };
}
