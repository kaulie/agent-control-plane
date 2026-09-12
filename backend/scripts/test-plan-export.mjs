/**
 * Unit checks for plan export helpers.
 * Usage: npm run build -w backend && node backend/scripts/test-plan-export.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPlanMarkdown,
  exportPlanDocument,
} from "../dist/plan-export.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const task = {
  taskId: "task-abc",
  projectId: "proj-1",
  title: "Dental plan",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const project = { projectId: "proj-1", name: "Dental", createdAt: "", updatedAt: "" };
const events = [
  {
    eventId: "e1",
    taskId: "task-abc",
    runId: "run-1234567890",
    eventType: "agent_response",
    payload: { text: "Step 1: analyze\nStep 2: implement" },
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const md = buildPlanMarkdown({
  exportDir: "/tmp/plans",
  task,
  project,
  runId: "run-1234567890",
  userText: "Make a plan",
  runEvents: events,
});

assert(md.includes("# Plan — Dental plan"), "title in markdown");
assert(md.includes("Step 1: analyze"), "plan body in markdown");
assert(md.includes("## Plan"), "plan section heading");
assert(md.includes("task-abc"), "taskId in markdown");

const streamed = buildPlanMarkdown({
  exportDir: "/tmp/plans",
  task,
  project,
  runId: "run-stream",
  userText: "test",
  runEvents: [
    {
      eventId: "e1",
      taskId: "task-abc",
      runId: "run-stream",
      eventType: "agent_response",
      payload: { text: "评价" },
      createdAt: "",
    },
    {
      eventId: "e2",
      taskId: "task-abc",
      runId: "run-stream",
      eventType: "agent_response",
      payload: { text: "：**" },
      createdAt: "",
    },
    {
      eventId: "e3",
      taskId: "task-abc",
      runId: "run-stream",
      eventType: "agent_response",
      payload: { text: "方向对了" },
      createdAt: "",
    },
  ],
});
assert(
  streamed.includes("评价：**方向对了"),
  "streaming chunks concatenated, not one word per line",
);
assert(
  !streamed.includes("评价\n\n**"),
  "streaming chunks must not be joined with blank lines",
);

const prefersResult = buildPlanMarkdown({
  exportDir: "/tmp/plans",
  task,
  project,
  runId: "run-final",
  userText: "test",
  runEvents: [
    {
      eventId: "e1",
      taskId: "task-abc",
      runId: "run-final",
      eventType: "agent_response",
      payload: { text: "partial" },
      createdAt: "",
    },
  ],
  runResult: "Complete plan body",
});
assert(
  prefersResult.includes("Complete plan body"),
  "runResult preferred over streaming events",
);
assert(!prefersResult.includes("partial"), "runResult replaces partial events");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-export-test-"));
const result = exportPlanDocument({
  exportDir: tmpRoot,
  task,
  project,
  runId: "run-1234567890",
  userText: "Make a plan",
  runEvents: events,
});

assert(fs.existsSync(result.filePath), "file created");
assert(result.fileName.endsWith(".md"), "md extension");
assert(
  result.filePath.includes(path.join("proj-1", "task-abc")),
  "nested by project and task",
);

let threw = false;
try {
  exportPlanDocument({
    exportDir: "relative/path",
    task,
    runId: "run-x",
    userText: "",
    runEvents: [],
  });
} catch (e) {
  threw = true;
  assert(String(e).includes("absolute"), "relative path rejected");
}
assert(threw, "relative exportDir throws");

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("PASS: plan export");
