/** Classified run failure kinds for UI + diagnostics. */
export type RunErrorKind =
  | "user_stop"
  | "server_restart"
  | "sdk_aborted"
  | "network"
  | "busy"
  | "image_unsupported"
  | "other";

export interface ClassifiedRunError {
  kind: RunErrorKind;
  /** User-facing Chinese (or passthrough) message. */
  message: string;
}

/** True when the raw error is an AbortError / "operation was aborted" cancel. */
export function isSdkAbortError(raw: string | undefined | null): boolean {
  const s = (raw ?? "").trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return (
    /operation was aborted|aborterror/.test(lower) ||
    (/\[cancel/i.test(s) && /abort/i.test(lower))
  );
}

/** Silent first-turn aborts (no tools / no model calls) are safe to retry once. */
export function isRetryableSilentAbort(
  raw: string | undefined | null,
  stats: { toolCalls: number; modelCalls: number },
): boolean {
  if (!isSdkAbortError(raw)) return false;
  return (stats.toolCalls || 0) === 0 && (stats.modelCalls || 0) === 0;
}

export function classifyRunError(
  raw: string | undefined | null,
): ClassifiedRunError {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "other", message: "未知错误" };

  const lower = s.toLowerCase();

  if (/interrupted \(server restart\)/i.test(s)) {
    return { kind: "server_restart", message: "任务因服务重启中断" };
  }
  if (isSdkAbortError(s)) {
    return {
      kind: "sdk_aborted",
      message: "任务中断：Cursor 连接在无响应后被取消（通常为网络/API 空转，并非用户点了停止）",
    };
  }
  if (
    /network request failed|fetch failed|connection stalled|econnreset|etimedout|socket hang up|api key exchange/i.test(
      lower,
    )
  ) {
    return {
      kind: "network",
      message: "网络异常：无法稳定连接 Cursor API，请检查代理或稍后重试",
    };
  }
  if (/already has active run/i.test(lower)) {
    return { kind: "busy", message: "Agent 正忙，请等待当前任务结束" };
  }
  if (/does not support image input/i.test(s)) {
    return {
      kind: "image_unsupported",
      message: "当前 Agent 不支持图片输入，请改用支持多模态的 Agent 或仅发送文字",
    };
  }

  return { kind: "other", message: s };
}

/** Map raw SDK / provider errors to user-facing messages. */
export function formatRunErrorMessage(
  raw: string | undefined | null,
): string {
  return classifyRunError(raw).message;
}
