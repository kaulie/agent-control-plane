/** Follow-up message mode for `agentPath=autonomy` tasks. */
export const EXECUTOR_INPUT_MODES = ["chat", "command"] as const;
export type ExecutorInputMode = (typeof EXECUTOR_INPUT_MODES)[number];
export const DEFAULT_EXECUTOR_INPUT_MODE: ExecutorInputMode = "command";

export function isExecutorInputMode(value: unknown): value is ExecutorInputMode {
  return value === "chat" || value === "command";
}

/** Empty / omitted → command（老行为：追加一条可改 plan 的指令）。 */
export function parseExecutorInputMode(
  raw: unknown,
): { ok: true; mode: ExecutorInputMode } | { ok: false; error: string } {
  if (raw == null || raw === "") {
    return { ok: true, mode: DEFAULT_EXECUTOR_INPUT_MODE };
  }
  if (isExecutorInputMode(raw)) return { ok: true, mode: raw };
  return { ok: false, error: 'mode must be "chat" or "command"' };
}
