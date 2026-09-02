import type { AgentEvent, RunRecord, Task } from "./types";

export interface PlanRunContent {
  runId: string;
  planBody: string;
  markdown: string;
  exportedPath?: string;
  exportedFileName?: string;
  run?: RunRecord;
  startedAt?: string;
  hasDraft: boolean;
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

function stripQuestionFence(text: string): string {
  return text.replace(/```web-cursor-plan-questions[\s\S]*?```/gi, "").trim();
}

function isDraftText(text: string): boolean {
  const t = text.trim();
  if (/```web-cursor-plan-draft/i.test(t)) return true;
  if (/^#\s*plan\b/im.test(t)) return true;
  if (/^##\s*计划/m.test(t)) return true;
  return false;
}

function collectPlanBody(events: AgentEvent[], runId: string, runResult?: string): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.runId !== runId) continue;
    if (ev.eventType === "plan_draft") {
      const text = typeof ev.payload.text === "string" ? ev.payload.text.trim() : "";
      if (text) parts.push(stripQuestionFence(text));
      continue;
    }
    if (ev.eventType !== "agent_response") continue;
    const raw = typeof ev.payload.text === "string" ? ev.payload.text.trim() : "";
    if (!raw || raw === "(questions pending)") continue;
    const text = stripQuestionFence(raw);
    if (!text || !isDraftText(text)) continue;
    parts.push(text);
  }
  if (parts.length) return parts.join("\n\n");
  return runResult?.trim() && isDraftText(runResult) ? runResult.trim() : "";
}

function buildMarkdown(taskTitle: string, planBody: string): string {
  if (!planBody) {
    return `# ${taskTitle}\n\n## 计划\n\n_(采集中 — Agent 正在澄清需求，成稿后将显示在此)_\n`;
  }
  return [`# ${taskTitle}`, "", "## 计划", "", planBody, ""].join("\n");
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
  if (task.workflowState === "plan") {
    for (const r of runs) runIds.add(r.runId);
  }

  const runById = new Map(runs.map((r) => [r.runId, r]));
  const out: PlanRunContent[] = [];

  for (const runId of runIds) {
    const run = runById.get(runId);
    const planBody = collectPlanBody(events, runId, run?.result);
    const hasDraft =
      planBody.length > 0 ||
      events.some((e) => e.runId === runId && e.eventType === "plan_draft");

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
      planBody,
      markdown: buildMarkdown(task.title, planBody),
      exportedPath,
      exportedFileName,
      run,
      startedAt,
      hasDraft,
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
  return planRuns.some((p) => p.hasDraft || p.planBody.length > 0);
}
