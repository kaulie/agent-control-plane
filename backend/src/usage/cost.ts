import type { CostInfo, TokenUsage } from "../types.js";
import { findPricing } from "./pricing.js";
import { uncachedInputTokens } from "./tokens.js";

/**
 * Estimate cost in USD cents from token usage, using the pricing table.
 * Used only when the SDK does not report a server-derived (billed) cost.
 * `inputTokens` is treated as full prompt size (cache inclusive).
 */
export function estimateCostCents(usage: TokenUsage, modelId?: string): number {
  const p = findPricing(modelId);
  const usd =
    (uncachedInputTokens(usage) / 1e6) * p.inputPerMTok +
    ((usage.outputTokens || 0) / 1e6) * p.outputPerMTok +
    ((usage.cacheReadTokens || 0) / 1e6) * p.cacheReadPerMTok +
    ((usage.cacheWriteTokens || 0) / 1e6) * p.cacheWritePerMTok;
  return Math.round(usd * 100 * 100) / 100;
}

export interface SdkCostLike {
  rawCostCents?: number;
  chargedCents?: number;
}

export function buildCost(
  usage: TokenUsage | undefined,
  modelId?: string,
  sdkCost?: SdkCostLike,
): CostInfo | undefined {
  if (!usage) return undefined;
  const chargedCents =
    sdkCost && typeof sdkCost.chargedCents === "number" && sdkCost.chargedCents > 0
      ? sdkCost.chargedCents
      : undefined;
  return {
    rawCostCents: sdkCost?.rawCostCents,
    chargedCents,
    estimatedCents: estimateCostCents(usage, modelId),
    currency: "USD",
    model: modelId,
  };
}
