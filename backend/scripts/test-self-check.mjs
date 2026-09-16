/**
 * Self-check feedback: an unclosed user message must be classified by cause —
 * "the run was interrupted mid-flight" is NOT the same as "it never started" —
 * and a message the queue resumes must not get a second (self-check) run.
 *
 * Usage: node backend/scripts/test-self-check.mjs
 *        (needs `npm run build --workspace backend` for dist/*)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, newId } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import {
  buildSelfCheckPrompt,
  findLatestUnclosedUserMessage,
  findTasksNeedingSelfCheck,
} from "../dist/feedback.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-selfcheck-test-"));
const store = new Store(dataDir);
const project = store.createProject("self-check");

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}`, extra === undefined ? "" : extra);
}

function newTask(title) {
  return store.createTask({
    title,
    workspace: path.join(dataDir, title),
    provider: "cursor",
    projectId: project.projectId,
  });
}

function ev(taskId, runId, eventType, payload = {}) {
  const event = {
    eventId: newId("evt"),
    taskId,
    runId,
    agentId: "agent-1",
    timestamp: new Date().toISOString(),
    eventType,
    payload,
  };
  store.appendEvent(event);
  return event;
}

function selfCheckEvent(taskId) {
  return store
    .listEvents(taskId, { limit: 100 })
    .events.find((e) => e.payload?.selfCheck === true);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1) queued message that never started -------------------------------
console.log("case 1: message only ever queued (never started)");
const t1 = newTask("queued");
store.createRun({
  runId: "run-q1",
  taskId: t1.taskId,
  agentId: "",
  provider: "cursor",
  status: "queued",
});
ev(t1.taskId, "run-q1", "user_message", {
  text: "排队后没跑起来的请求",
  mode: "agent",
  queued: true,
});
const u1 = findLatestUnclosedUserMessage(store, t1.taskId);
check("cause = never_started", u1?.cause === "never_started", u1);
const p1 = buildSelfCheckPrompt(u1);
check("prompt says it never started", p1.includes("从未真正开始执行"), p1);
check(
  "prompt does not claim an interruption",
  !p1.includes("意外中断") && !p1.includes("被服务重启打断"),
  p1,
);
check("prompt keeps the original text", p1.includes("排队后没跑起来的请求"), p1);

// ---- 2) run started, then the process died mid-run ----------------------
console.log("case 2: run interrupted mid-flight (restart)");
const t2 = newTask("running");
store.createRun({
  runId: "run-r2",
  taskId: t2.taskId,
  agentId: "",
  provider: "cursor",
  status: "running",
});
ev(t2.taskId, "run-r2", "user_message", { text: "改到一半的请求", mode: "agent" });
ev(t2.taskId, "run-r2", "run_started", { cwd: dataDir });
ev(t2.taskId, "run-r2", "tool_call_started", { tool: "edit" });
ev(t2.taskId, "run-r2", "tool_call_started", { tool: "read" });
ev(t2.taskId, "run-r2", "file_edit", { path: "a.ts" });
ev(t2.taskId, "run-r2", "terminal", { command: "npm test" });
ev(t2.taskId, "run-r2", "agent_response", { text: "中间输出" });
const u2 = findLatestUnclosedUserMessage(store, t2.taskId);
check("cause = interrupted", u2?.cause === "interrupted", u2);
const p2 = buildSelfCheckPrompt(u2);
check("prompt blames the restart", p2.includes("被服务重启打断"), p2);
check(
  "prompt reports what was already done",
  p2.includes("工具调用 2 次") &&
    p2.includes("文件改动 1 次") &&
    p2.includes("终端命令 1 条"),
  p2,
);

// ---- 3) the real startup path: markInterruptedRuns -----------------------
console.log("case 3: startup finalizes only the interrupted run");
const finalized = store.markInterruptedRuns();
check(
  "running run finalized as interrupted",
  finalized.finalized.some((f) => f.runId === "run-r2"),
  finalized.finalized.map((f) => f.runId),
);
check(
  "queued run left alone (never started)",
  store.listRuns(t1.taskId).every((r) => r.status === "queued"),
  store.listRuns(t1.taskId),
);
const u2b = findLatestUnclosedUserMessage(store, t2.taskId);
check("still interrupted after finalize", u2b?.cause === "interrupted", u2b);
const u1b = findLatestUnclosedUserMessage(store, t1.taskId);
check("still never_started after finalize", u1b?.cause === "never_started", u1b);

// ---- 4) a closed message is not reported --------------------------------
console.log("case 4: completed run closes its user message");
const t3 = newTask("done");
store.createRun({
  runId: "run-d3",
  taskId: t3.taskId,
  agentId: "",
  provider: "cursor",
  status: "running",
});
ev(t3.taskId, "run-d3", "user_message", { text: "已经答完的请求", mode: "agent" });
ev(t3.taskId, "run-d3", "run_completed", {});
store.updateRun("run-d3", {
  status: "finished",
  completedAt: new Date().toISOString(),
  result: "ok",
});
check(
  "completed run is closed",
  findLatestUnclosedUserMessage(store, t3.taskId) === undefined,
);

// ---- 5) no run row at all -> unknown, generic wording -------------------
console.log("case 5: no run row / no evidence -> unknown");
const t4 = newTask("unknown");
ev(t4.taskId, "run-missing", "user_message", {
  text: "没有 run 记录的请求",
  mode: "agent",
});
const u4 = findLatestUnclosedUserMessage(store, t4.taskId);
check("cause = unknown", u4?.cause === "unknown", u4);
check(
  "unknown keeps the generic wording",
  buildSelfCheckPrompt(u4).startsWith(
    "[系统自检] 上一条用户消息的处理意外中断",
  ),
  buildSelfCheckPrompt(u4),
);

// ---- 6) a delivered self-check closes the message -----------------------
console.log("case 6: completed self-check satisfies feedback");
const t5 = newTask("selfchecked");
store.createRun({
  runId: "run-s5",
  taskId: t5.taskId,
  agentId: "",
  provider: "cursor",
  status: "running",
});
ev(t5.taskId, "run-s5", "user_message", { text: "之前被打断的请求", mode: "agent" });
ev(t5.taskId, "run-s5", "run_started", { cwd: dataDir });
store.createRun({
  runId: "run-sc5",
  taskId: t5.taskId,
  agentId: "",
  provider: "cursor",
  status: "running",
});
ev(t5.taskId, "run-sc5", "user_message", {
  text: "[系统自检] ...",
  mode: "agent",
  selfCheck: true,
  resumesRunId: "run-s5",
});
ev(t5.taskId, "run-sc5", "run_completed", {});
store.updateRun("run-sc5", {
  status: "finished",
  completedAt: new Date().toISOString(),
  result: "final answer",
});
check(
  "self-check closes the resumed message",
  findLatestUnclosedUserMessage(store, t5.taskId) === undefined,
);

const needing = findTasksNeedingSelfCheck(store).map((p) => p.taskId);
check(
  "findTasksNeedingSelfCheck lists exactly the unclosed tasks",
  needing.length === 3 &&
    [t1.taskId, t2.taskId, t4.taskId].every((id) => needing.includes(id)) &&
    !needing.includes(t3.taskId) &&
    !needing.includes(t5.taskId),
  needing,
);

// ---- 7) the queue owns a never-started message: no duplicate run --------
console.log("case 7: queue resumes it, self-check must not run it twice");
const t6 = newTask("queue-owns");
store.createRun({
  runId: "run-q6",
  taskId: t6.taskId,
  agentId: "",
  provider: "cursor",
  status: "queued",
});
ev(t6.taskId, "run-q6", "user_message", {
  text: "服务重启时还在排队",
  mode: "agent",
  queued: true,
});

let activeRunId = null;
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
    await sleep(150);
    activeRunId = null;
    return {
      status: "finished",
      result: `done:${input.prompt.text}`,
      durationMs: 150,
      modelCalls: 1,
      toolCalls: 0,
      agentId: "agent-mock",
    };
  },
};
const registry = new ProviderRegistry("cursor", [provider]);
const gateway = new AgentGateway(
  store,
  registry,
  { agentWorkspaceRoot: dataDir, dataDir },
  () => {},
);

const recovered = gateway.recoverQueuedRuns();
check(
  "queue recovered every queued run (never-started messages)",
  recovered === 2,
  recovered,
);

// A queued row the queue did NOT pick up (it can happen after startup) is the
// remaining case where self-check must still deliver the never_started prompt.
const t7 = newTask("queued-unowned");
store.createRun({
  runId: "run-q7",
  taskId: t7.taskId,
  agentId: "",
  provider: "cursor",
  status: "queued",
});
ev(t7.taskId, "run-q7", "user_message", {
  text: "队列没接管的请求",
  mode: "agent",
  queued: true,
});

const selfChecks = await gateway.runPendingSelfChecks();
check(
  "self-check fired only for the tasks the queue does not own",
  selfChecks === 3,
  selfChecks,
);
check("no queued work was left behind", gateway.getQueueLength(t6.taskId) === 0);

const t6Events = store.listEvents(t6.taskId, { limit: 100 });
check(
  "no self-check event for the queue-owned message",
  t6Events.events.every((e) => e.payload?.selfCheck !== true),
  t6Events.events.map((e) => e.eventType),
);
check(
  "no self-check event for the other queue-resumed message",
  selfCheckEvent(t1.taskId) === undefined,
);

await sleep(600);
check(
  "queue run finished on its own",
  store.listRuns(t6.taskId).some((r) => r.runId === "run-q6" && r.status === "finished"),
  store.listRuns(t6.taskId),
);
check(
  "queue-owned message is closed",
  findLatestUnclosedUserMessage(store, t6.taskId) === undefined,
);

const sc7 = selfCheckEvent(t7.taskId);
check(
  "unowned queued message gets the never_started wording",
  String(sc7?.payload.text ?? "").includes("从未真正开始执行"),
  sc7?.payload,
);
check(
  "never_started self-check is tagged with its cause",
  sc7?.payload.selfCheckCause === "never_started",
  sc7?.payload,
);
const sc2 = selfCheckEvent(t2.taskId);
check(
  "interrupted message self-check uses the restart wording",
  String(sc2?.payload.text ?? "").includes("被服务重启打断"),
  sc2?.payload,
);
check(
  "interrupted message self-check resumes the right run",
  sc2?.payload.resumesRunId === "run-r2",
  sc2?.payload,
);

store.close();
fs.rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nFAIL: ${failures} self-check assertion(s) failed`);
  process.exit(1);
}
console.log("\nPASS: self-check cause classification + no duplicate queue run");
process.exit(0);
