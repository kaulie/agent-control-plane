import type { AgentEvent, RunRecord } from "./types.js";
import type { Store } from "./store/db.js";

/**
 * Feedback closure for user messages: any run that lacks a terminal assistant
 * outcome (completed / error / meaningful cancel) is "unclosed". Self-check is
 * a generic delivery mechanism — not tied to deploy or any single interrupt cause.
 *
 * Unclosed messages do NOT all mean the same thing, and the prompt must not
 * pretend they do:
 *   - `interrupted`   the run did start, then the process died mid-run
 *                     (restart / crash) → there may be half-finished work, so the
 *                     agent has to verify state before answering.
 *   - `never_started` the message only ever sat in the queue; no agent ever ran
 *                     it, so there is no "interrupted scene" to inspect — the
 *                     request simply has to be executed.
 *   - `unknown`       no run row and no timeline evidence — say so instead of
 *                     guessing a cause.
 */

const INTERRUPTED_RUN_ERROR = "interrupted (server restart)";

/** Why an unclosed user message never got a terminal reply. */
export type UnclosedCause = "interrupted" | "never_started" | "unknown";

/** Narrow an unknown payload field to a known cause. */
export function isUnclosedCause(value: unknown): value is UnclosedCause {
  return (
    value === "interrupted" || value === "never_started" || value === "unknown"
  );
}

/** What an interrupted run had already done (best effort, run row + timeline). */
export interface UnclosedProgress {
  modelCalls: number;
  toolCalls: number;
  fileEdits: number;
  commands: number;
  outputs: number;
}

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

/** Last terminal event recorded for a run, if any. */
function lastTerminalEvent(
  runId: string,
  events: AgentEvent[],
): AgentEvent | undefined {
  let last: AgentEvent | undefined;
  for (const e of events) {
    if (e.runId !== runId) continue;
    if (
      e.eventType === "run_completed" ||
      e.eventType === "run_error" ||
      e.eventType === "run_cancelled"
    ) {
      last = e;
    }
  }
  return last;
}

/** Timeline evidence that the agent actually got going on this run. */
function runStarted(runId: string, events: AgentEvent[]): boolean {
  return events.some(
    (e) => e.runId === runId && e.eventType === "run_started",
  );
}

/** Classify why the run behind an unclosed user message never closed. */
export function classifyUnclosedCause(
  runId: string,
  events: AgentEvent[],
  runRecord?: RunRecord,
): UnclosedCause {
  const terminal = lastTerminalEvent(runId, events);
  if (
    terminal?.eventType === "run_cancelled" &&
    terminal.payload?.reason === "server_restart"
  ) {
    return "interrupted";
  }

  const started = runStarted(runId, events);

  if (runRecord) {
    if (runRecord.status === "queued" && !started) return "never_started";
    if (runRecord.status === "running") return "interrupted";
    if (
      runRecord.status === "cancelled" &&
      runRecord.error === INTERRUPTED_RUN_ERROR
    ) {
      return "interrupted";
    }
  }

  if (started) return "interrupted";
  return "unknown";
}

/** Count what the run produced, for the interrupted prompt. */
function collectProgress(
  runId: string,
  events: AgentEvent[],
  runRecord?: RunRecord,
): UnclosedProgress {
  const progress: UnclosedProgress = {
    modelCalls: runRecord?.modelCalls ?? 0,
    toolCalls: runRecord?.toolCalls ?? 0,
    fileEdits: 0,
    commands: 0,
    outputs: 0,
  };
  let toolCallStarts = 0;
  for (const e of events) {
    if (e.runId !== runId) continue;
    switch (e.eventType) {
      case "tool_call_started":
        toolCallStarts += 1;
        break;
      case "file_edit":
        progress.fileEdits += 1;
        break;
      case "terminal":
        progress.commands += 1;
        break;
      case "agent_response":
      case "thinking":
        progress.outputs += 1;
        break;
      default:
        break;
    }
  }
  progress.toolCalls = Math.max(progress.toolCalls, toolCallStarts);
  return progress;
}

/** A completed self-check run satisfies feedback for the run it resumes. */
function hasCompletedSelfCheckFor(
  runId: string,
  events: AgentEvent[],
  runById: Map<string, RunRecord>,
): boolean {
  for (const e of events) {
    if (e.eventType !== "user_message") continue;
    if (e.payload.selfCheck !== true) continue;
    if (e.payload.resumesRunId !== runId) continue;
    if (isRunFeedbackComplete(e.runId, events, runById.get(e.runId))) {
      return true;
    }
  }
  return false;
}

export interface UnclosedUserMessage {
  runId: string;
  text: string;
  timestamp: string;
  /** Why it never closed (drives the self-check wording). */
  cause: UnclosedCause;
  progress: UnclosedProgress;
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
    const runRecord = runById.get(um.runId);
    const complete =
      isRunFeedbackComplete(um.runId, events, runRecord) ||
      hasCompletedSelfCheckFor(um.runId, events, runById);
    if (!complete) {
      return {
        runId: um.runId,
        text,
        timestamp: um.timestamp,
        cause: classifyUnclosedCause(um.runId, events, runRecord),
        progress: collectProgress(um.runId, events, runRecord),
      };
    }
  }
  return undefined;
}

/** Human-readable summary of an interrupted run's progress. */
function describeProgress(progress: UnclosedProgress): string {
  const parts: string[] = [];
  if (progress.modelCalls) parts.push(`模型调用 ${progress.modelCalls} 次`);
  if (progress.toolCalls) parts.push(`工具调用 ${progress.toolCalls} 次`);
  if (progress.fileEdits) parts.push(`文件改动 ${progress.fileEdits} 次`);
  if (progress.commands) parts.push(`终端命令 ${progress.commands} 条`);
  if (parts.length) return parts.join("、");
  return progress.outputs
    ? "已产生中间输出，但没有任何工具调用或命令"
    : "无（尚未产生任何可观察的动作）";
}

export function buildSelfCheckPrompt(unclosed: UnclosedUserMessage): string {
  const { cause, progress, text } = unclosed;

  if (cause === "never_started") {
    return [
      "[系统自检] 上一条用户消息一直排在队列里，从未真正开始执行（服务重启时它还没轮到，也没有留下任何半成品）。",
      "注意：这不是“执行中被中断”——不要去找中断现场，也不要假设已有部分改动落地。",
      "",
      "尚未执行的用户消息：",
      text,
      "",
      "请把它当作一条尚未处理过的新请求直接执行，并给出明确的终态回复（完成或失败均可，不要停在中间过程）。",
    ].join("\n");
  }

  if (cause === "interrupted") {
    return [
      "[系统自检] 上一条用户消息的执行被服务重启打断（整个进程结束，不是回复被截断）。",
      `中断前已产生的动作：${describeProgress(progress)}（据时间线统计，可能不完整）。`,
      "",
      "被中断的用户消息：",
      text,
      "",
      "请先核对已落地的改动与当前实际状态（工作区、git、进程），再给出明确的终态回复（完成或失败均可，不要停在中间过程）。",
    ].join("\n");
  }

  return [
    "[系统自检] 上一条用户消息的处理意外中断，尚未给出明确终态回复。",
    "",
    "被中断的用户消息：",
    text,
    "",
    "请核对当前状态与未完成项，并给出明确的终态回复（完成或失败均可，不要停在中间过程）。",
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
