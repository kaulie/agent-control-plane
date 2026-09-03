/** Map raw SDK / provider errors to user-facing messages (Timeline display). */
export function formatRunErrorMessage(
  raw: string | undefined | null,
): string {
  const s = (raw ?? "").trim();
  if (!s) return "未知错误";

  const lower = s.toLowerCase();
  if (
    /operation was aborted|aborterror/.test(lower) ||
    (/\[cancel/i.test(s) && /abort/i.test(lower))
  ) {
    return "任务被中断（用户停止或服务重启）";
  }
  if (/interrupted \(server restart\)/i.test(s)) {
    return "任务因服务重启中断";
  }
  if (/already has active run/i.test(lower)) {
    return "Agent 正忙，请等待当前任务结束";
  }
  if (/does not support image input/i.test(s)) {
    return "当前 Agent 不支持图片输入，请改用支持多模态的 Agent 或仅发送文字";
  }

  return s;
}
