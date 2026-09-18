/**
 * token 估算（**故意保留两个口径**，别再混用）。
 *
 * 起点：2026-09-18 实测 —— pdf-reader 的会话 6.71MB 文本 ≈ 1,048,576 tokens，
 * 即 **≈6.4 字符/token**（中英混排 + 代码 + 终端输出）。
 *
 * - `MEASURED_CHARS_PER_TOKEN = 6.4`：按上面实测校准，**展示用**（"大概多少 token"最接近真实）；
 * - `CONSERVATIVE_CHARS_PER_TOKEN = 3`：与 Cline SDK 的 `estimateTokens()` 一致
 *   （它的注释写明 "slightly over-counts vs the conventional 4 so trigger thresholds fire
 *   before provider rejection rather than after"）→ **阈值 / 守卫用**，宁可偏早。
 *
 * 任何写进事件或给用户看的估算数，都要同时说明是哪个口径：
 * `seededTokens`（measured）+ `seededTokensUpperBound`（conservative）。
 */
export const MEASURED_CHARS_PER_TOKEN = 6.4;
export const CONSERVATIVE_CHARS_PER_TOKEN = 3;

/** 文本 → 估算 tokens（默认按实测比；ratio 越小估得越多）。 */
export function estimateTextTokens(
  text: string,
  ratio: number = MEASURED_CHARS_PER_TOKEN,
): number {
  if (!text) return 0;
  return Math.ceil(text.length / Math.max(1, ratio));
}

/** 一条消息的字符数（JSON 序列化的近似：对象按 JSON 长度）。 */
export function messageChars(message: unknown): number {
  if (typeof message === "string") return message.length;
  if (message == null) return 0;
  try {
    return JSON.stringify(message).length;
  } catch {
    return String(message).length;
  }
}

export function messagesChars(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) total += messageChars(message);
  return total;
}

export function estimateMessagesTokens(
  messages: readonly unknown[],
  ratio: number = MEASURED_CHARS_PER_TOKEN,
): number {
  return estimateTextTokens("x".repeat(messagesChars(messages)), ratio);
}

/** 一次给两个口径（展示值 + 保守上界），避免调用方自己选错。 */
export function estimateMessagesTokenRange(messages: readonly unknown[]): {
  chars: number;
  tokens: number;
  tokensUpperBound: number;
} {
  const chars = messagesChars(messages);
  return {
    chars,
    tokens: estimateTextTokens("x".repeat(chars), MEASURED_CHARS_PER_TOKEN),
    tokensUpperBound: estimateTextTokens("x".repeat(chars), CONSERVATIVE_CHARS_PER_TOKEN),
  };
}
