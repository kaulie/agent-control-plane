/**
 * 自动轮转（兜底）的判定 —— 纯函数，网关算完交给 provider 执行。
 *
 * 分层（见 ./README.md）：
 *
 * | 线 | 谁在管 | 干什么 |
 * | --- | --- | --- |
 * | **85%** `CONTEXT_ALERT_PERCENT` | 用户 | 提示"建议 fork 新 task"，由人决定 |
 * | **90%**（core 自带）| SDK | 启用 compaction 后 core 自己压（`triggerRatio = 0.9`）|
 * | **~88%** `CONTEXT_ROTATE_PERCENT` | 系统 | 兜底：换会话（用户什么都没点也不会卡死）|
 * | **上一次就是被窗口顶死的** | 系统 | **无条件轮转** —— 否则再发一句只会再失败一次（不可逆）|
 *
 * 判据里显式留出 `CONTEXT_ROTATE_RESERVE_TOKENS`：实测单个 run 内部还能自己长 ~60k
 * （pdf-reader：38 次调用的 run 内部 +66k），不留余量就会"看着没到 100% 却已经发不出去了"。
 */

/** 兜底轮转的占比线（%）。 */
export const CONTEXT_ROTATE_PERCENT = 88;
/** 给"本次输入 + 下一轮增长 + 输出"留的余量（tokens）。 */
export const CONTEXT_ROTATE_RESERVE_TOKENS = 60_000;

/** 单张图片的粗略 token 估算（图片按面积计费，不按 base64 字符数）。 */
export const IMAGE_TOKEN_ESTIMATE = 1_500;

export interface RotateInput {
  /** 当前会话请求体量（`TaskContextSize.tokens`）；未知 → 不轮转（不猜）。 */
  tokens?: number;
  /** 模型窗口；未知 → 不轮转（不猜）。 */
  limit?: number;
  /** 本次用户输入（文本 + 图片）的估算 tokens。 */
  incomingTokens?: number;
  /** 上一次 run 是否因上下文超限失败 → 无条件轮转。 */
  lastRunOverflow?: boolean;
  /** 总开关（`CONTEXT_AUTO_ROTATE=0` 时 false）。 */
  enabled?: boolean;
  rotatePercent?: number;
  reserveTokens?: number;
}

export type RotateReason = "over_threshold" | "last_run_overflow";

export interface RotateDecision {
  rotate: boolean;
  reason?: RotateReason;
  /** 触发时的占比（%），给事件/日志用。 */
  percent?: number;
  /** 实际生效的触发线（tokens）。 */
  triggerTokens?: number;
  detail?: string;
}

export function shouldRotateContext(input: RotateInput): RotateDecision {
  if (input.enabled === false) return { rotate: false };

  const limit = input.limit;
  const rotatePercent = input.rotatePercent ?? CONTEXT_ROTATE_PERCENT;
  const reserve = Math.max(0, input.reserveTokens ?? CONTEXT_ROTATE_RESERVE_TOKENS);
  const tokens = input.tokens;
  const incoming = Math.max(0, input.incomingTokens ?? 0);

  // 上一次就被顶死了：这时候再发一句只会再失败一次，必须换会话（与阈值无关）。
  if (input.lastRunOverflow) {
    return {
      rotate: true,
      reason: "last_run_overflow",
      ...(tokens != null && limit ? { percent: round1((tokens / limit) * 100) } : {}),
      ...(limit ? { triggerTokens: limit } : {}),
      detail: "上一次 run 因上下文超限失败 —— 直接轮转，避免再撞一次",
    };
  }

  if (tokens == null || !limit || limit <= 0) return { rotate: false };

  const threshold = Math.min((limit * rotatePercent) / 100, limit - reserve);
  const projected = tokens + incoming;
  const percent = round1((projected / limit) * 100);
  if (projected >= threshold) {
    return {
      rotate: true,
      reason: "over_threshold",
      percent,
      triggerTokens: Math.round(threshold),
      detail: `会话已达 ${percent}%（含本次输入 ${incoming} tokens，触发线 ${Math.round(threshold)}）`,
    };
  }
  return { rotate: false, percent };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
