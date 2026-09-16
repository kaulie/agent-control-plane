import { buildPlanMarkdown } from "./plan-export.js";
import type { Store } from "./store/db.js";
import type { AgentEvent } from "./types.js";

export interface PlanDocumentSummary {
  runId: string;
  exportedAt: string;
  userText?: string;
}

export interface PlanDocumentContent {
  runId: string;
  markdown: string;
  exportedAt: string;
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

/** One entry per finished plan run of the task (most recent first). */
export function listPlanDocuments(
  store: Store,
  taskId: string,
): PlanDocumentSummary[] {
  const { events } = store.listEvents(taskId, { limit: 2000 });
  const runs = store.listRuns(taskId);
  const runById = new Map(runs.map((r) => [r.runId, r]));

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
    summaries.push({
      runId,
      exportedAt: run.completedAt ?? run.createdAt,
      userText: userTextForRun(events, runId),
    });
  }

  summaries.sort((a, b) => b.exportedAt.localeCompare(a.exportedAt));
  return summaries;
}

/** Plan markdown rebuilt from the run's events (nothing is written to disk anymore). */
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

  const project = store.getProject(task.projectId);
  const markdown = buildPlanMarkdown({
    task,
    project: project ?? undefined,
    runId,
    runEvents: events.filter((e) => e.runId === runId),
    runResult: run.result,
  });

  return {
    runId,
    markdown,
    exportedAt: run.completedAt ?? run.createdAt,
  };
}
