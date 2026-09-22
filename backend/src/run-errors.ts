/** Classified run failure kinds for UI + diagnostics. */
export type RunErrorKind =
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

/**
 * 上游对**工具调用配对**的 400 —— 「role 'tool' 的消息前面没有带 tool_calls 的消息」
 * （OpenAI 风格 provider，DeepSeek 的原文：
 * `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`；
 * Anthropic 风格的等价错误是 `tool_result ... must have a corresponding tool_use`）。
 *
 * 它只可能来自**喂进去的历史**（seed / 续接 / 切模式搬会话）里工具调用被打断，所以
 * 专门识别：命中就意味着「这段历史不能用」，该丢掉重开 —— 把这个会话留在内存里的话，
 * 之后每条消息都会立刻 400（2026-09-20 实测卡死过两个任务）。
 */
export function isToolPairingError(raw: string | undefined | null): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return false;
  if (/tool_calls/.test(s) && /role[^\w]{0,3}tool\b/.test(s)) return true;
  return /tool_?result\b/.test(s) && /corresponding tool_use/.test(s);
}

/**
 * 上游**账号额度**用尽（Cursor 原文：
 * `Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.`）。
 *
 * 它跟本应用无关，是 `CURSOR_API_KEY` 对应账号在 Cursor 侧的 fast/高级模型用量耗尽
 * —— 关键点：① 只挡**非 Auto 模型**（原文自己就说 `Switch to Auto`），Auto 仍可用；
 * ② 换页面 / 换浏览器 / 在别处「更新账户」都不改变本应用用的账号与额度，所以用户会觉得
 * 「我账户都更新了怎么还提示额度不够」。识别出来给可操作中文，别把英文原文透传。
 */
export function isQuotaError(raw: string | undefined | null): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return false;
  return /out of usage|increase limits for faster responses|exceeded your current quota|insufficient_quota|insufficient (credits|quota|funds)/.test(
    s,
  );
}

/** 额度用尽的可操作中文（与 `web/src/run-errors.ts` 保持同一口径）。 */
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
