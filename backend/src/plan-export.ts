import type { AgentEvent, Project, Task } from "./types.js";

export interface PlanExportInput {
  task: Task;
  project?: Project;
  runId: string;
  runEvents: AgentEvent[];
  runResult?: string;
}

function collectPlanBody(events: AgentEvent[], runResult?: string): string {
  const final = runResult?.trim();
  if (final) return final;

  let merged = "";
  for (const ev of events) {
    if (ev.eventType === "plan_draft") {
      const text = typeof ev.payload.text === "string" ? ev.payload.text.trim() : "";
      if (text) merged += text;
      continue;
    }
    if (ev.eventType !== "agent_response") continue;
    const text = typeof ev.payload.text === "string" ? ev.payload.text : "";
    if (!text || text === "(questions pending)") continue;
    if (/```web-cursor-plan-questions/i.test(text)) continue;
    if (text) merged += text;
  }
  if (merged.trim()) return merged.trim();
  return "(no plan content)";
}

export function buildPlanMarkdown(input: PlanExportInput): string {
  const { task, project, runId, runEvents, runResult } = input;
  const planBody = collectPlanBody(runEvents, runResult);
  const exportedAt = new Date().toISOString();
  return [
    `# Plan — ${task.title}`,
    "",
    `- taskId: ${task.taskId}`,
    `- runId: ${runId}`,
    `- project: ${project?.name ?? task.projectId} (${task.projectId})`,
    `- exportedAt: ${exportedAt}`,
    "",
    "## Plan",
    "",
    planBody,
    "",
  ].join("\n");
}
