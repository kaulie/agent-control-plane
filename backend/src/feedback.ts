import type { AgentEvent, RunRecord } from "./types.js";
import type { Store } from "./store/db.js";

const INTERRUPTED_RUN_ERROR = "interrupted (server restart)";

/** Terminal feedback that closes a user message (B: not server_restart cancel). */
export function isRunFeedbackComplete(
  runId: string,
  events: AgentEvent[],
  runRecord?: RunRecord,
): boolean {
  const terminal = events.filter(
    (e) =>
      e.runId === runId &&
      (e.eventType === "run_completed" ||
        e.eventType === "run_error" ||
        e.eventType === "run_cancelled"),
  );

  if (terminal.length > 0) {
    const last = terminal[terminal.length - 1]!;
    if (
      last.eventType === "run_completed" ||
      last.eventType === "run_error"
    ) {
      return true;
    }
    if (last.eventType === "run_cancelled") {
      return last.payload?.reason !== "server_restart";
    }
  }

  if (runRecord) {
    if (runRecord.status === "finished" || runRecord.status === "error") {
      return true;
    }
    if (
      runRecord.status === "cancelled" &&
      runRecord.error !== INTERRUPTED_RUN_ERROR
    ) {
      return true;
    }
  }

  return false;
}

export interface UnclosedUserMessage {
  runId: string;
  text: string;
  timestamp: string;
}

/** Latest user message on this task whose run never received valid feedback. */
export function findLatestUnclosedUserMessage(
  store: Store,
  taskId: string,
): UnclosedUserMessage | undefined {
  const { events } = store.listEvents(taskId, { limit: 500 });
  const runs = store.listRuns(taskId);
  const runById = new Map(runs.map((r) => [r.runId, r]));

  const userMsgs = events.filter((e) => e.eventType === "user_message");
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const um = userMsgs[i]!;
    const text =
      typeof um.payload.text === "string" ? um.payload.text.trim() : "";
    if (!text) continue;
    if (
      !isRunFeedbackComplete(um.runId, events, runById.get(um.runId))
    ) {
      return {
        runId: um.runId,
        text,
        timestamp: um.timestamp,
      };
    }
  }
  return undefined;
}

export function buildSelfCheckPrompt(unclosed: UnclosedUserMessage): string {
  return [
    "[系统自检] 上一条用户消息的处理意外中断，尚未给出明确终态回复。",
    "",
    "被中断的用户消息：",
    unclosed.text,
    "",
    "请核对当前状态（含未完成项、部署或健康检查结果如有），并给出明确的终态回复（完成或失败均可，不要停在中间过程）。",
  ].join("\n");
}

export function findTasksNeedingSelfCheck(
  store: Store,
): Array<{ taskId: string; unclosed: UnclosedUserMessage }> {
  const out: Array<{ taskId: string; unclosed: UnclosedUserMessage }> = [];
  for (const task of store.listTasks()) {
    const unclosed = findLatestUnclosedUserMessage(store, task.taskId);
    if (unclosed) {
      out.push({ taskId: task.taskId, unclosed });
    }
  }
  return out;
}
