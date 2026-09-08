import type { TokenUsage } from "../types.js";

/**
 * How a provider's usage fields combine into dashboard-comparable volume.
 *
 * Observed Cursor SDK + Cursor dashboard (Sep 2026):
 * - Dashboard Total = Input(w/o Cache Write) + Cache Read + Output
 * - SDK `inputTokens` behaves as full prompt (already includes cache reads),
 *   so Input(w/o) ≈ input − cacheRead − cacheWrite.
 * - Therefore volume = input + output (same as inclusive). Adding cacheRead
 *   again double-counts against the dashboard Total.
 *
 * - `inclusive`: `inputTokens` is the full prompt; cache read/write are a
 *   breakdown of that input. Volume = input + output.
 *   Used for Cursor and Cline / DeepSeek.
 * - `disjoint` (reserved): `inputTokens` is uncached-only; cache fields are
 *   extra. Volume = input + output + cacheRead + cacheWrite.
 */
export type TokenVolumeMode = "inclusive" | "disjoint";

export function volumeModeForProvider(provider?: string | null): TokenVolumeMode {
  void provider;
  // All current providers report inclusive input. Keep the mode switch so a
  // future disjoint source can opt in without another rewrite of call sites.
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
 * Map SDK fields onto Cursor dashboard columns when input is inclusive.
 * Input(w/o Cache Write) + Cache + Output == input + output.
 */
export function dashboardTokenParts(
  usage: Pick<
    TokenUsage,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): {
  inputWithoutCache: number;
  cacheTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const cacheRead = Number(usage.cacheReadTokens) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens) || 0;
  const cacheTokens = cacheRead + cacheWrite;
  const inputWithoutCache = Math.max(0, input - cacheTokens);
  return {
    inputWithoutCache,
    cacheTokens,
    outputTokens: output,
    totalTokens: inputWithoutCache + cacheTokens + output,
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
