import type { AutonomyTarget } from "./types";

/** 页面上的短名：与任务字段 `autonomyTarget` 一一对应。 */
export const AUTONOMY_TARGET_LABEL: Record<AutonomyTarget, string> = {
  local: "本地",
  remote: "海外",
};

export function autonomyTargetLabel(target?: AutonomyTarget | null): string {
  return AUTONOMY_TARGET_LABEL[target === "remote" ? "remote" : "local"];
}

export function autonomyTargetHint(target?: AutonomyTarget | null): string {
  return target === "remote"
    ? "这条任务由海外机 autonomy 执行（AUTONOMY_REMOTE_API_URL）"
    : "这条任务由本地 autonomy 执行（AUTONOMY_API_URL）";
}
