/**
 * Unit checks for plan document listing + synthesis (no files on disk).
 * Usage: npm run build -w backend && node backend/scripts/test-plan-documents.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../dist/store/db.js";
import { listPlanDocuments, readPlanDocument } from "../dist/plan-documents.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-docs-test-"));
const dataDir = path.join(tmp, "data");

const store = new Store(path.join(dataDir, "test.db"));
const project = store.createProject("p");
const task = store.createTask({
  taskId: "task-plan-1",
  title: "Plan task",
  workspace: path.join(tmp, "ws"),
  provider: "mock",
  projectId: project.projectId,
});

const runId = "run-plan-abc123";
store.createRun({
  runId,
  taskId: task.taskId,
  agentId: "agent-1",
  provider: "mock",
  status: "finished",
});
store.updateRun(runId, {
  status: "finished",
  completedAt: "2026-09-02T04:00:00.000Z",
  result: "Complete plan text here.",
});

store.appendEvent({
  eventId: "evt-um",
  taskId: task.taskId,
  runId,
  agentId: "agent-1",
  timestamp: "2026-09-02T03:59:00.000Z",
  eventType: "user_message",
  payload: { text: "Make a plan", mode: "plan" },
});

const list = listPlanDocuments(store, task.taskId);
assert(list.length === 1, "one plan listed");
assert(list[0].runId === runId, "runId matches");
assert(
  list[0].exportedAt === "2026-09-02T04:00:00.000Z",
  "exportedAt from run completion",
);

const doc = readPlanDocument(store, task.taskId, runId);
assert(doc?.markdown.includes("Complete plan text here."), "markdown content");
assert(doc?.markdown.includes("# Plan — Plan task"), "title in markdown");
assert(doc?.markdown.includes("task-plan-1"), "taskId in markdown");
assert(doc?.exportedAt === "2026-09-02T04:00:00.000Z", "doc exportedAt");

let threw = false;
try {
  readPlanDocument(store, task.taskId, "missing-run");
} catch {
  threw = true;
}
assert(!threw, "missing run returns undefined not throw");
assert(
  readPlanDocument(store, task.taskId, "missing-run") === undefined,
  "missing run undefined",
);

store.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS: plan documents");
