/**
 * Event id entropy + UNIQUE retry.
 * Usage: npx tsx scripts/test-event-ids.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newId, Store } from "../src/store/db.ts";

const hex = (id, prefix) => {
  assert.match(id, new RegExp(`^${prefix}-[0-9a-f]{16}$`));
};

{
  const a = newId("evt");
  const b = newId("evt");
  hex(a, "evt");
  hex(b, "evt");
  assert.notEqual(a, b, "newId must not collide in the same tick");
  hex(newId("task"), "task");
  hex(newId("run"), "run");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evt-id-test-"));
const store = new Store(tmp);
const project = store.createProject("p");
const task = store.createTask({
  taskId: "task-evt-id",
  title: "ids",
  workspace: path.join(tmp, "ws"),
  provider: "mock",
  projectId: project.projectId,
});
store.createRun({
  runId: "run-evt-id",
  taskId: task.taskId,
  agentId: "agent-1",
  provider: "mock",
  status: "running",
});

const base = {
  taskId: task.taskId,
  runId: "run-evt-id",
  agentId: "agent-1",
  timestamp: new Date().toISOString(),
  eventType: "status",
};

store.appendEvent({
  ...base,
  eventId: "evt-dup",
  payload: { n: 1 },
});
// Same id must not throw — store allocates a new event_id.
store.appendEvent({
  ...base,
  eventId: "evt-dup",
  payload: { n: 2 },
});

const { events } = store.listEvents(task.taskId, { limit: 10 });
assert.equal(events.length, 2, "both events persisted");
assert.equal(events[0].eventId, "evt-dup");
assert.notEqual(events[1].eventId, "evt-dup", "retry assigned a fresh id");
assert.equal(events[0].payload.n, 1);
assert.equal(events[1].payload.n, 2);
assert.ok(events[0].seq != null && events[1].seq != null);
assert.ok(events[1].seq > events[0].seq);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS: event id entropy + unique retry");
