import type { TokenUsage } from "../types.js";

/**
 * How a provider's usage fields combine into dashboard-comparable volume.
 *
 * - `inclusive` (Cline / DeepSeek AI SDK): `inputTokens` is the full prompt;
 *   cache read/write are a breakdown of that input. Volume = input + output.
 * - `disjoint` (Cursor / Anthropic-style): `inputTokens` is uncached-only;
 *   cache fields are extra. Volume = input + output + cacheRead + cacheWrite.
 */
export type TokenVolumeMode = "inclusive" | "disjoint";

export function volumeModeForProvider(provider?: string | null): TokenVolumeMode {
  const p = (provider ?? "").trim().toLowerCase();
  if (p === "cursor") return "disjoint";
  return "inclusive";
}

export function tokenVolume(
  usage:
    | Pick<
        TokenUsage,
        "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
      >
    | undefined
    | null,
  provider?: string | null,
): number {
  if (!usage) return 0;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  if (volumeModeForProvider(provider) === "disjoint") {
    return input + output + cacheRead + cacheWrite;
  }
  return input + output;
}

/** Rewrite `totalTokens` using the provider's volume mode. */
export function normalizeTokenUsage(
  usage: TokenUsage,
  provider?: string | null,
): TokenUsage {
  return {
    ...usage,
    totalTokens: tokenVolume(usage, provider),
  };
}

/**
 * Input tokens billed at the full (uncached) input rate.
 * - inclusive: subtract cache portions already inside `inputTokens`
 * - disjoint: `inputTokens` is already uncached-only
 */
export function billableInputTokens(
  usage: Pick<TokenUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  provider?: string | null,
): number {
  const input = Number(usage.inputTokens) || 0;
  if (volumeModeForProvider(provider) === "disjoint") return input;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  return Math.max(0, input - cacheRead - cacheWrite);
}

/** @deprecated Prefer billableInputTokens(usage, provider). */
export function uncachedInputTokens(
  usage: Pick<TokenUsage, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): number {
  return billableInputTokens(usage, "cline");
}
