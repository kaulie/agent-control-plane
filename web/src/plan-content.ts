import type { AgentEvent, RunRecord, Task } from "./types";

export interface PlanRunContent {
  runId: string;
  userText: string;
  planBody: string;
  markdown: string;
  exportedPath?: string;
  exportedFileName?: string;
  run?: RunRecord;
  startedAt?: string;
}

function runMode(events: AgentEvent[], runId: string): "agent" | "plan" | undefined {
  for (const ev of events) {
    if (ev.runId !== runId) continue;
    if (ev.eventType !== "user_message" && ev.eventType !== "run_started") continue;
    const m = ev.payload.mode;
    if (m === "plan" || m === "agent") return m;
  }
  return undefined;
}

function collectPlanBody(events: AgentEvent[], runId: string, runResult?: string): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.runId !== runId || ev.eventType !== "agent_response") continue;
    const text = typeof ev.payload.text === "string" ? ev.payload.text.trim() : "";
    if (text) parts.push(text);
  }
  if (parts.length) return parts.join("\n\n");
  return runResult?.trim() || "";
}

function userTextForRun(events: AgentEvent[], runId: string): string {
  for (const ev of events) {
    if (ev.runId !== runId || ev.eventType !== "user_message") continue;
    return String(ev.payload.text ?? "").trim();
  }
  return "";
}

function buildMarkdown(taskTitle: string, userText: string, planBody: string): string {
  const sections = [`# ${taskTitle}`, ""];
  if (userText) {
    sections.push("## 用户需求", "", userText, "");
  }
  sections.push("## 计划", "", planBody || "_(暂无内容)_", "");
  return sections.join("\n");
}

/** Extract plan-mode runs from task events, newest first. */
export function extractPlanRuns(
  events: AgentEvent[],
  task: Task,
  runs: RunRecord[],
): PlanRunContent[] {
  const runIds = new Set<string>();
  for (const ev of events) {
    if (runMode(events, ev.runId) === "plan") runIds.add(ev.runId);
  }

  const runById = new Map(runs.map((r) => [r.runId, r]));
  const out: PlanRunContent[] = [];

  for (const runId of runIds) {
    const run = runById.get(runId);
    const userText = userTextForRun(events, runId);
    const planBody = collectPlanBody(events, runId, run?.result);
    if (!planBody && !userText) continue;

    let exportedPath: string | undefined;
    let exportedFileName: string | undefined;
    for (const ev of events) {
      if (ev.runId !== runId || ev.eventType !== "plan_exported") continue;
      exportedPath =
        typeof ev.payload.path === "string" ? ev.payload.path : undefined;
      exportedFileName =
        typeof ev.payload.fileName === "string" ? ev.payload.fileName : undefined;
    }

    const startedAt =
      run?.createdAt ??
      events.find((e) => e.runId === runId && e.eventType === "run_started")?.timestamp;

    out.push({
      runId,
      userText,
      planBody,
      markdown: buildMarkdown(task.title, userText, planBody),
      exportedPath,
      exportedFileName,
      run,
      startedAt,
    });
  }

  out.sort((a, b) => {
    const ta = a.startedAt ?? "";
    const tb = b.startedAt ?? "";
    return tb.localeCompare(ta);
  });

  return out;
}

export function hasPlanContent(planRuns: PlanRunContent[]): boolean {
  return planRuns.some((p) => p.planBody.length > 0 || p.userText.length > 0);
}
