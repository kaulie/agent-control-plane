/**
 * Pricing table for the Cursor Agent SDK models (USD per 1M tokens).
 * Kept in one place, away from the UI, as required by the spec.
 * These are reasonable estimates used only when the SDK does not return a
 * server-derived cost (local agents are often plan-included => $0 charged).
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const DEFAULT_PRICING: ModelPricing = {
  inputPerMTok: 3.0,
  outputPerMTok: 15.0,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

const PRICING_BY_FAMILY: Array<{ match: string; pricing: ModelPricing }> = [
  {
    match: "opus",
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  },
  {
    match: "sonnet",
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  },
  {
    match: "haiku",
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },
  },
  {
    match: "gemini",
    pricing: { inputPerMTok: 0.5, outputPerMTok: 4, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.5 },
  },
  {
    match: "gpt",
    pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
  },
  {
    match: "composer",
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  },
  {
    match: "claude",
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  },
];

export function findPricing(modelId?: string): ModelPricing {
  if (!modelId) return DEFAULT_PRICING;
  const m = modelId.toLowerCase();
  const hit = PRICING_BY_FAMILY.find((p) => m.includes(p.match));
  return hit ? hit.pricing : DEFAULT_PRICING;
}
