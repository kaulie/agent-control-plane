/** Classified run failure kinds for Timeline display. */
export type RunErrorKind =
  | "context_window"
  | "user_stop"
  | "server_restart"
  | "sdk_aborted"
  | "network"
  | "quota"
  | "busy"
  | "image_unsupported"
  | "other";

export interface ClassifiedRunError {
  kind: RunErrorKind;
  message: string;
}

export function isSdkAbortError(raw: string | undefined | null): boolean {
  const s = (raw ?? "").trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  return (
    /operation was aborted|aborterror/.test(lower) ||
    (/\[cancel/i.test(s) && /abort/i.test(lower))
  );
}

/**
 * 上游**账号额度**用尽（Cursor 原文：
 * `Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.`）。
 *
 * 与本应用无关：是 `CURSOR_API_KEY` 对应账号在 Cursor 侧的 fast/高级模型用量耗尽，
 * 只挡非 Auto 模型（原文自己就让人 `Switch to Auto`）。识别出来给可操作中文 ——
 * 否则用户会以为「我账户都更新了怎么还提示额度不够」。
 */
export function isQuotaError(raw: string | undefined | null): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return false;
  return /out of usage|increase limits for faster responses|exceeded your current quota|insufficient_quota|insufficient (credits|quota|funds)/.test(
    s,
  );
}

/** 额度用尽的可操作中文（与 `backend/src/run-errors.ts` 保持同一口径）。 */
export const QUOTA_ERROR_MESSAGE =
  "Cursor 额度已用尽（只影响非 Auto 模型）：CURSOR_API_KEY 对应账号的 fast/高级模型用量已耗尽。" +
  "先在模型下拉切到 Auto（default）即可继续；要恢复高级模型，需由该账号的管理员提升额度 —— " +
  "在别处「更新账户」不会改变本应用实际使用的账号与额度。";

export function classifyRunError(
  raw: string | undefined | null,
): ClassifiedRunError {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "other", message: "未知错误" };

  const lower = s.toLowerCase();

  if (isQuotaError(s)) {
    return { kind: "quota", message: QUOTA_ERROR_MESSAGE };
  }

  // 上下文撞模型窗口：给可操作的中文（原文只说"no conversation history to compact"，谁也看不懂）。
  if (
    /exceeds the model's context window|maximum context length|context window exceeded|contextwindowoverflow/i.test(
      s,
    )
  ) {
    return {
      kind: "context_window",
      message:
        "上下文已超出模型窗口，这个会话发不出消息了：请在 Context 条上点「Fork 新 task」" +
        "（或新开 task）换个会话继续 —— 完整历史仍在时间线里",
    };
  }
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

/** Map raw SDK / provider errors to user-facing messages (Timeline display). */
export function formatRunErrorMessage(
  raw: string | undefined | null,
): string {
  return classifyRunError(raw).message;
}
