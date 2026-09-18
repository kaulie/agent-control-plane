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
  /** provider / SDK 自己上报的金额；原样留档，不参与本表计价。 */
  reported?: { rawCostCents?: number; chargedCents?: number };
  /** 没有任何规则命中时保留的旧本地估算（兼容历史口径）。 */
  fallbackEstimatedCents?: number;
}

/**
 * 产出 `run.cost_json`：
 * - 命中规则 → `estimatedCents` = 按表算出来的钱（USD cents）+ 明细 `billing`；
 * - 没命中规则但有上报值 / 兜底估算 → 原样保留（行为与改造前一致）；
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
    if (
      reported.chargedCents == null &&
      reported.rawCostCents == null &&
      input.fallbackEstimatedCents == null
    ) {
      return undefined;
    }
    return {
      ...base,
      ...(input.fallbackEstimatedCents != null
        ? { estimatedCents: input.fallbackEstimatedCents }
        : {}),
    };
  }

  const billing = priceWithRule(match.rule, input.usage, input.at, match.matchedBy);
  return { ...base, estimatedCents: billing.usdCents, billing };
}
