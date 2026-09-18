import type { CostInfo, TokenUsage } from "../../types.js";
import { billableInputTokens } from "../../usage/tokens.js";
import type { BillingService } from "../../billing/service.js";

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
  /**
   * 计费模块（数据源 = `billing_rules` 表）。注入了就以计费表为准；
   * 缺省时保持旧行为：SDK 上报的 `totalCost` + 下面的本地价目估算。
   */
  billing?: BillingService;
  /**
   * 是否启用 SDK 自带的上下文压缩（`config.compaction`）。默认 **true**。
   *
   * 探针结论（2026-09-18，`@cline/core` 源码）：压缩是 opt-in 的 ——
   * `BY()` 里 `if (config.compaction?.enabled !== true) return;`，返回 undefined 就等于
   * **没有 `prepareTurn`**，于是长会话只会撞 provider 的硬上限，报
   * "no conversation history to compact"（这正是 pdf-reader 的死法）。
   * 打开后 core 会在 90% 时自己压缩（basic = 内置 token 预算截断投影，不需要 summarizer）。
   */
  compaction?: boolean;
  /** 压缩策略：basic（默认）/ agentic（LLM 摘要式，**默认关**，需要 summarizer）。 */
  compactionStrategy?: "basic" | "agentic";
  /** agentic 摘要用的模型（缺省 = 会话模型）。 */
  compactionModel?: string;
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
export const DEEPSEEK_FALLBACK_MODELS: Array<{
  id: string;
  displayName: string;
  /** 目录不可达时的兜底窗口（与 `@cline/llms` 目录一致）。 */
  contextWindow: number;
  maxInputTokens: number;
  maxTokens: number;
}> = [
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxTokens: 384_000 },
  { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxTokens: 384_000 },
  { id: "deepseek-v4-flash-vision-exp", displayName: "DeepSeek V4 Flash Vision Exp", contextWindow: 1_000_000, maxInputTokens: 1_000_000, maxTokens: 384_000 },
];

export interface PricingPerMTok {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Approximate DeepSeek pricing (USD per 1M tokens) — **兜底估算**，只在没有任何
 * `billing_rules` 规则命中（或没注入计费模块）时用。真正的账目口径在计费模块里。
 */
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

/**
 * 计费：命中 `billing_rules` 规则时以**计费表**为准 —— `estimatedCents` = 表算出来的钱，
 * 逐项明细落在 `cost_json.billing`；SDK 上报的 `totalCost` 只写进 `chargedCents`（对比口径）。
 * 没有计费模块（老构造路径 / 单测）时与改造前行为完全一致。
 */
export function buildCostWithBilling(
  billing: BillingService | undefined,
  usage: TokenUsage,
  modelId: string | undefined,
  at: string,
  totalCostUsd?: number,
): CostInfo | undefined {
  const legacy = buildCostInfo(usage, modelId, totalCostUsd);
  if (!billing) return legacy;
  return billing.costFor({
    provider: "cline",
    model: modelId,
    usage,
    at,
    reported: {
      ...(legacy?.chargedCents != null ? { chargedCents: legacy.chargedCents } : {}),
      ...(legacy?.rawCostCents != null ? { rawCostCents: legacy.rawCostCents } : {}),
    },
    ...(legacy?.estimatedCents != null
      ? { fallbackEstimatedCents: legacy.estimatedCents }
      : {}),
  });
}
