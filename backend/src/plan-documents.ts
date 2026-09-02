import fs from "node:fs";
import path from "node:path";
import { buildPlanMarkdown } from "./plan-export.js";
import { resolvePlanExportDir } from "./settings.js";
import type { Store } from "./store/db.js";
import type { AgentEvent } from "./types.js";

export interface PlanDocumentSummary {
  runId: string;
  fileName?: string;
  path?: string;
  exportedAt: string;
  userText?: string;
  hasFile: boolean;
}

export interface PlanDocumentContent {
  runId: string;
  markdown: string;
  path?: string;
  fileName?: string;
  exportedAt: string;
  source: "file" | "synthesized";
}

export function isPathUnderExportRoot(filePath: string, root: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedFile === resolvedRoot ||
    resolvedFile.startsWith(resolvedRoot + path.sep)
  );
}

function userTextForRun(events: AgentEvent[], runId: string): string {
  const um = events.find(
    (e) => e.runId === runId && e.eventType === "user_message",
  );
  return typeof um?.payload.text === "string" ? um.payload.text : "";
}

function isPlanRun(events: AgentEvent[], runId: string): boolean {
  const um = events.find(
    (e) => e.runId === runId && e.eventType === "user_message",
  );
  return um?.payload.mode === "plan";
}

export function listPlanDocuments(
  store: Store,
  taskId: string,
): PlanDocumentSummary[] {
  const { events } = store.listEvents(taskId, { limit: 2000 });
  const runs = store.listRuns(taskId);
  const runById = new Map(runs.map((r) => [r.runId, r]));

  const exported = new Map<string, PlanDocumentSummary>();
  for (const ev of events) {
    if (ev.eventType !== "plan_exported") continue;
    const p = ev.payload;
    exported.set(ev.runId, {
      runId: ev.runId,
      path: typeof p.path === "string" ? p.path : undefined,
      fileName: typeof p.fileName === "string" ? p.fileName : undefined,
      exportedAt: ev.timestamp,
      userText: userTextForRun(events, ev.runId),
      hasFile: true,
    });
  }

  const planRunIds = new Set<string>();
  for (const ev of events) {
    if (ev.eventType === "user_message" && ev.payload.mode === "plan") {
      planRunIds.add(ev.runId);
    }
  }

  const summaries: PlanDocumentSummary[] = [];
  for (const runId of planRunIds) {
    const run = runById.get(runId);
    if (!run || run.status !== "finished") continue;

    const existing = exported.get(runId);
    if (existing) {
      summaries.push(existing);
      continue;
    }

    summaries.push({
      runId,
      exportedAt: run.completedAt ?? run.createdAt,
      userText: userTextForRun(events, runId),
      hasFile: false,
    });
  }

  summaries.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt));
  return summaries;
}

export function readPlanDocument(
  store: Store,
  taskId: string,
  runId: string,
): PlanDocumentContent | undefined {
  const task = store.getTask(taskId);
  if (!task) return undefined;

  const { events } = store.listEvents(taskId, { limit: 2000 });
  if (!isPlanRun(events, runId)) return undefined;

  const run = store.listRuns(taskId).find((r) => r.runId === runId);
  if (!run || run.status !== "finished") return undefined;

  const summaries = listPlanDocuments(store, taskId);
  const summary = summaries.find((s) => s.runId === runId);
  if (!summary) return undefined;

  const project = store.getProject(task.projectId);
  const globalSettings = store.getGlobalSettings();
  const projectSettings = store.getProjectSettings(task.projectId) ?? {};
  const exportDir = resolvePlanExportDir(globalSettings, projectSettings);

  if (summary.path && summary.hasFile && exportDir) {
    if (!isPathUnderExportRoot(summary.path, exportDir)) {
      throw new Error("plan path is outside configured export directory");
    }
    if (fs.existsSync(summary.path)) {
      return {
        runId,
        markdown: fs.readFileSync(summary.path, "utf8"),
        path: summary.path,
        fileName: summary.fileName,
        exportedAt: summary.exportedAt,
        source: "file",
      };
    }
  }

  const runEvents = events.filter((e) => e.runId === runId);
  const markdown = buildPlanMarkdown({
    exportDir: exportDir || task.workspace,
    task,
    project: project ?? undefined,
    runId,
    userText: userTextForRun(events, runId),
    runEvents,
    runResult: run.result,
  });

  return {
    runId,
    markdown,
    path: summary.path,
    fileName: summary.fileName,
    exportedAt: summary.exportedAt,
    source: "synthesized",
  };
}
