import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, Project, Task } from "./types.js";

export interface PlanExportInput {
  exportDir: string;
  task: Task;
  project?: Project;
  runId: string;
  userText: string;
  runEvents: AgentEvent[];
  runResult?: string;
}

export interface PlanExportResult {
  filePath: string;
  fileName: string;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function collectPlanBody(events: AgentEvent[], runResult?: string): string {
  const final = runResult?.trim();
  if (final) return final;

  let merged = "";
  for (const ev of events) {
    if (ev.eventType !== "agent_response") continue;
    const text = typeof ev.payload.text === "string" ? ev.payload.text : "";
    if (text) merged += text;
  }
  if (merged.trim()) return merged.trim();
  return "(no plan content)";
}

export function buildPlanMarkdown(input: PlanExportInput): string {
  const { task, project, runId, userText, runEvents, runResult } = input;
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
    "## User request",
    "",
    userText.trim() || "(empty)",
    "",
    "## Plan",
    "",
    planBody,
    "",
  ].join("\n");
}

export function exportPlanDocument(input: PlanExportInput): PlanExportResult {
  const root = input.exportDir.trim();
  if (!root) throw new Error("exportDir is required");
  if (!path.isAbsolute(root)) {
    throw new Error("plan exportDir must be an absolute path");
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${ts}-${input.runId.slice(-6)}.md`;
  const dir = path.join(
    root,
    sanitizeSegment(input.task.projectId),
    sanitizeSegment(input.task.taskId),
  );
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buildPlanMarkdown(input), "utf8");
  return { filePath, fileName };
}
