import type { TokenUsage } from "../types.js";

/**
 * Token volume comparable to provider dashboards (e.g. DeepSeek
 * `usage.total_tokens`, Cursor billed volume).
 *
 * Cline (AI SDK) and Cursor report `inputTokens` as the **full** prompt size;
 * `cacheReadTokens` / `cacheWriteTokens` are a breakdown of that input, not
 * additional tokens. Therefore:
 *   volume = inputTokens + outputTokens
 * Do not add cache fields on top — that double-counts cache hits.
 */
export function tokenVolume(
  usage: Pick<TokenUsage, "inputTokens" | "outputTokens"> | undefined | null,
): number {
  if (!usage) return 0;
  return (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
}

/** Rewrite `totalTokens` to the non-double-counting volume. */
export function normalizeTokenUsage(usage: TokenUsage): TokenUsage {
  return {
    ...usage,
    totalTokens: tokenVolume(usage),
  };
}

/**
 * Uncached input tokens when `inputTokens` already includes cache read/write.
 * Clamped so bad provider payloads cannot go negative.
 */
export function uncachedInputTokens(
  usage: Pick<TokenUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): number {
  const input = Number(usage.inputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  return Math.max(0, input - cacheRead - cacheWrite);
}
