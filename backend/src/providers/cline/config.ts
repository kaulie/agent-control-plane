import type { CostInfo, TokenUsage } from "../../types.js";
import { billableInputTokens } from "../../usage/tokens.js";

/**
 * Configuration for the Cline provider (agent runtime adapter).
 * By default it drives DeepSeek via `DEEPSEEK_API_KEY`.
 */
export interface ClineProviderConfig {
  /** Cline/LLM provider id (e.g. "deepseek", "anthropic", "openai-compatible"). */
  providerId?: string;
  /** Pinned model id; empty = auto-discover from the provider catalog. */
  model?: string;
  /** Provider API key (e.g. DEEPSEEK_API_KEY). */
  apiKey?: string;
  /** Optional base URL override for OpenAI-compatible providers. */
  baseUrl?: string;
  /** System prompt used for new sessions. */
  systemPrompt?: string;
}

export const DEFAULT_PROVIDER_ID = "deepseek";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Cline, an autonomous coding agent running behind a web UI.",
  "Work inside the workspace directory configured for the current task.",
  "Read and edit files, run commands, and use the available tools to complete the task.",
  "When you are done, finish with a concise summary of what you changed and why.",
].join(" ");

/**
 * DeepSeek fallback model catalog, used only when `@cline/llms` returns no
 * registered models for the configured provider.
 */
export const DEEPSEEK_FALLBACK_MODELS: Array<{ id: string; displayName: string }> = [
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp" },
];

export interface PricingPerMTok {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Approximate DeepSeek pricing (USD per 1M tokens). Estimate-only fallback. */
export const DEEPSEEK_PRICING: PricingPerMTok = {
  input: 0.28,
  output: 0.42,
  cacheRead: 0.028,
  cacheWrite: 0.28,
};

/** Estimate cost in USD cents from token usage (DeepSeek pricing). */
export function estimateCostCents(usage: TokenUsage): number {
  // inputTokens already includes cache; price the uncached remainder separately.
  const usd =
    (billableInputTokens(usage, "cline") / 1e6) * DEEPSEEK_PRICING.input +
    ((usage.outputTokens || 0) / 1e6) * DEEPSEEK_PRICING.output +
    ((usage.cacheReadTokens || 0) / 1e6) * DEEPSEEK_PRICING.cacheRead +
    ((usage.cacheWriteTokens || 0) / 1e6) * DEEPSEEK_PRICING.cacheWrite;
  return Math.round(usd * 100 * 100) / 100;
}

/**
 * Build a unified CostInfo. Prefers the server-reported total cost (USD)
 * when present; otherwise falls back to the DeepSeek pricing estimate.
 */
export function buildCostInfo(
  usage: TokenUsage,
  modelId: string | undefined,
  totalCostUsd?: number,
): CostInfo {
  const chargedCents =
    typeof totalCostUsd === "number" && totalCostUsd > 0
      ? Math.round(totalCostUsd * 100)
      : undefined;
  return {
    ...(chargedCents != null ? { chargedCents } : {}),
    estimatedCents: estimateCostCents(usage),
    currency: "USD",
    ...(modelId ? { model: modelId } : {}),
  };
}
