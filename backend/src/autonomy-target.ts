/**
 * 哪一台 autonomy 执行这条任务（`Task.autonomyTarget`）。
 *
 * `agentPath=autonomy` 只说「执行交给 autonomy」；本机和海外是两台 runtime，
 * 创建时必须选一台，并记在任务行上，后续代理（executor / 追加指令 / 账号池）都打那一台。
 *
 * - `local`（默认）：`AUTONOMY_API_URL`（本机 `127.0.0.1:4300`）
 * - `remote`：`AUTONOMY_REMOTE_API_URL`（海外机 agent-oversea）
 *
 * 老任务没有这一列 → 当 `local`。
 */
export const AUTONOMY_TARGETS = ["local", "remote"] as const;

export type AutonomyTarget = (typeof AUTONOMY_TARGETS)[number];

export const DEFAULT_AUTONOMY_TARGET: AutonomyTarget = "local";

export function isAutonomyTarget(value: unknown): value is AutonomyTarget {
  return (
    typeof value === "string" &&
    (AUTONOMY_TARGETS as readonly string[]).includes(value.trim())
  );
}

export function normalizeAutonomyTarget(value: unknown): AutonomyTarget {
  return isAutonomyTarget(value) ? (value.trim() as AutonomyTarget) : DEFAULT_AUTONOMY_TARGET;
}
