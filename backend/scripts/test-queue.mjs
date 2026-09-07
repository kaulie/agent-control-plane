/**
 * Quick integration test: user messages queue while a run is active.
 * Usage: node backend/scripts/test-queue.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { ProviderRegistry } from "../dist/providers/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-queue-test-"));

/** @type {import("../dist/providers/types.js").AgentProvider} */
const provider = {
  name: "cursor",
  async verifyAuth() {
    return { ok: true, detail: "mock" };
  },
  async listModels() {
    return [];
  },
  async resolveModel() {
    return undefined;
  },
  async cancel(runId) {
    return activeRunId === runId;
  },
  async run(input) {
    activeRunId = input.runId;
    await sleep(400);
    activeRunId = null;
    return {
      status: "finished",
      result: `done:${input.prompt.text}`,
      durationMs: 400,
      modelCalls: 1,
      toolCalls: 0,
      agentId: "agent-mock",
    };
  },
};

let activeRunId = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const store = new Store(dataDir);
const events = [];
const registry = new ProviderRegistry("cursor", [provider]);
const gateway = new AgentGateway(
  store,
  registry,
  { agentWorkspaceRoot: dataDir, dataDir },
  (msg) => events.push(msg),
);

const task = gateway.createTask({ title: "queue-test" });

const r1 = await gateway.sendMessage(task.taskId, { text: "first" });
if (r1.queued) {
  console.error("FAIL: first message should not be queued");
  process.exit(1);
}

const r2 = await gateway.sendMessage(task.taskId, { text: "second" });
if (!r2.queued || r2.queueLength !== 1) {
  console.error("FAIL: second message should be queued", r2);
  process.exit(1);
}

const r3 = await gateway.sendMessage(task.taskId, { text: "third" });
if (!r3.queued || r3.queueLength !== 2) {
  console.error("FAIL: third message should be queued with length 2", r3);
  process.exit(1);
}

const cancelRes = gateway.cancelQueuedRun(task.taskId, r2.runId);
if (cancelRes.queueLength !== 1) {
  console.error("FAIL: cancelQueuedRun should leave one pending", cancelRes);
  process.exit(1);
}
const afterCancel = store.listRuns(task.taskId);
const cancelled = afterCancel.find((r) => r.runId === r2.runId);
if (!cancelled || cancelled.status !== "cancelled") {
  console.error("FAIL: cancelled run should be status=cancelled", cancelled);
  process.exit(1);
}
if (gateway.getQueueLength(task.taskId) !== 1) {
  console.error("FAIL: in-memory queue length after cancel");
  process.exit(1);
}
try {
  gateway.cancelQueuedRun(task.taskId, r1.runId);
  console.error("FAIL: cancelling active/non-queued run should throw");
  process.exit(1);
} catch {
  /* expected */
}

await sleep(1500);

const runs = store.listRuns(task.taskId);
const finished = runs.filter((r) => r.status === "finished");
const queued = runs.filter((r) => r.status === "queued");
const running = runs.filter((r) => r.status === "running");

if (finished.length !== 2) {
  console.error("FAIL: expected 2 finished runs (1 cancelled)", runs.map((r) => r.status));
  process.exit(1);
}
if (queued.length || running.length) {
  console.error("FAIL: leftover queued/running runs", runs.map((r) => r.status));
  process.exit(1);
}
const cancelledFinal = runs.filter((r) => r.status === "cancelled");
if (cancelledFinal.length !== 1 || cancelledFinal[0].runId !== r2.runId) {
  console.error("FAIL: expected exactly the cancelled queued run", cancelledFinal);
  process.exit(1);
}
if (gateway.getQueueLength(task.taskId) !== 0) {
  console.error("FAIL: in-memory queue not drained");
  process.exit(1);
}

const userMsgs = store
  .listEvents(task.taskId, { limit: 50 })
  .events.filter((e) => e.eventType === "user_message");
if (userMsgs.length !== 3) {
  console.error("FAIL: expected 3 user_message events");
  process.exit(1);
}

const cancelEv = store
  .listEvents(task.taskId, { limit: 50 })
  .events.find(
    (e) =>
      e.eventType === "run_cancelled" &&
      e.runId === r2.runId &&
      e.payload?.reason === "user_cancel_queued",
  );
if (!cancelEv) {
  console.error("FAIL: missing run_cancelled for queued cancel");
  process.exit(1);
}

console.log("PASS: message queue + cancel-queued works");
console.log(
  JSON.stringify({
    run1: r1,
    run2: r2,
    run3: r3,
    finishedRuns: finished.length,
    cancelledRuns: cancelledFinal.length,
    userMessages: userMsgs.length,
  }),
);

store.close();
fs.rmSync(dataDir, { recursive: true, force: true });
