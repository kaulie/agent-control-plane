/**
 * Agent 时间线（`GET /api/agents/:agentId/timeline`）检查。
 *
 * 时间线要把「某段时间内 agent 的工作状态」说清楚：
 * - thinking = 模型侧事件（thinking / agent_response / usage / status / run_started）
 * - working  = 工具侧事件（tool_call_started / tool_result / file_read / file_edit /
 *              terminal / search）
 * - idle     = 其余事件（用户消息、run 结束/取消/出错、agent 替换），以及「同一状态
 *              超过 5 分钟没有新事件」之后的部分（疑似卡住 → stall marker）
 * - 用户的 input（user_message）作为 marker + 单独的 runs.inputText 一起给出
 *
 * Usage: npm run build --workspace backend && node backend/scripts/test-agent-timeline.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { registerRoutes } from "../dist/http/routes.js";
import { buildAgentTimeline, stateOfEventType } from "../dist/timeline.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-agent-timeline-"));
const store = new Store(dataDir);
/** Only the bits registerRoutes / AgentGateway touch for these routes. */
const providers = {
  has: () => false,
  get default() {
    return {
      name: "cursor",
      verifyAuth: async () => ({ ok: true, detail: "" }),
      listModels: async () => [],
    };
  },
  list: () => [],
  reconcileAfterRestart: async () => {},
};

const gateway = new AgentGateway(
  store,
  providers,
  { agentWorkspaceRoot: path.join(dataDir, "ws"), dataDir },
  () => {},
);

const app = Fastify({ logger: false });
await registerRoutes(app, gateway, providers, {
  dataDir,
  appVersion: "0.0.0-test",
});

const timelineOf = async (agentId, query = "") => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/${encodeURIComponent(agentId)}/timeline${query}`,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

let seq = 0;
/** One run with explicit timestamps (`createRun` stamps "now", which we override). */
function recordRun(taskId, agentId, opts) {
  store.createRun({
    runId: opts.runId,
    taskId,
    agentId,
    provider: opts.provider ?? "cursor",
    ...(opts.model ? { model: opts.model } : {}),
    status: "running",
  });
  store.db
    .prepare(`UPDATE runs SET created_at = ? WHERE run_id = ?`)
    .run(opts.createdAt, opts.runId);
  store.updateRun(opts.runId, {
    status: opts.status ?? "finished",
    ...(opts.completedAt ? { completedAt: opts.completedAt } : {}),
    ...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
    modelCalls: opts.modelCalls ?? 0,
    toolCalls: opts.toolCalls ?? 0,
  });
}

function addEvent(taskId, runId, agentId, eventType, timestamp, payload = {}) {
  store.appendEvent({
    eventId: `evt-tl-${++seq}`,
    taskId,
    runId,
    agentId,
    timestamp,
    eventType,
    payload,
  });
}

const T = (s) => `2026-09-01T${s}.000Z`;
const FROM = T("10:00:00");
const TO = T("11:00:00");

const AGENT_ONE = "agent-11111111-1111-1111-1111-111111111111";
const AGENT_BUSY = "cls-2222222222222222";

const alpha = store.createProject("Alpha", {
  department: { departmentId: "D0001", departmentName: "SRE部门" },
});
const t1 = store.createTask({
  title: "时间线任务",
  workspace: path.join(dataDir, "t1"),
  provider: "cursor",
  model: "gpt-5",
  projectId: alpha.projectId,
});

// ---- 1) 一轮正常运行：thinking → working → run 完成 → 空闲 ----
// run-a: 10:00:00 → 10:05:00
recordRun(t1.taskId, AGENT_ONE, {
  runId: "run-a",
  createdAt: T("10:00:00"),
  completedAt: T("10:05:00"),
  durationMs: 300_000,
  model: "gpt-5",
  modelCalls: 4,
  toolCalls: 3,
});
addEvent(t1.taskId, "run-a", AGENT_ONE, "user_message", T("10:00:00"), {
  text: "round one",
  mode: "agent",
  images: [{ id: "img-1", mimeType: "image/png" }],
});
addEvent(t1.taskId, "run-a", AGENT_ONE, "run_started", T("10:00:01"), {
  cwd: "/tmp/t1",
  mode: "agent",
});
addEvent(t1.taskId, "run-a", AGENT_ONE, "thinking", T("10:00:10"), { text: "let me look" });
addEvent(t1.taskId, "run-a", AGENT_ONE, "file_read", T("10:01:10"), { toolType: "read" });
addEvent(t1.taskId, "run-a", AGENT_ONE, "terminal", T("10:01:20"), {
  toolType: "shell",
  result: "ok",
});
addEvent(t1.taskId, "run-a", AGENT_ONE, "run_completed", T("10:05:00"), {});

// ---- 2) 第二轮被重启掐死：thinking 之后长时间没有事件 → stall → idle ----
// run-b: 10:30:00 → 10:40:00（cancelled）
recordRun(t1.taskId, AGENT_ONE, {
  runId: "run-b",
  createdAt: T("10:30:00"),
  completedAt: T("10:40:00"),
  durationMs: 600_000,
  modelCalls: 1,
  toolCalls: 0,
  status: "cancelled",
});
addEvent(t1.taskId, "run-b", AGENT_ONE, "user_message", T("10:30:00"), {
  text: "round two",
  mode: "plan",
});
addEvent(t1.taskId, "run-b", AGENT_ONE, "run_started", T("10:30:01"), { mode: "plan" });
addEvent(t1.taskId, "run-b", AGENT_ONE, "thinking", T("10:30:05"), { text: "planning" });
addEvent(t1.taskId, "run-b", AGENT_ONE, "run_cancelled", T("10:40:00"), {
  reason: "server_restart",
});

// 窗口外的事件不应出现
addEvent(t1.taskId, "run-a", AGENT_ONE, "thinking", T("09:00:00"), { text: "before window" });

const { status: okStatus, body: tl } = await timelineOf(
  AGENT_ONE,
  `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
);
assert.equal(okStatus, 200);
assert.equal(tl.agentId, AGENT_ONE);
assert.equal(tl.agentName, "agent-11111111");
assert.equal(tl.taskId, t1.taskId);
assert.equal(tl.taskTitle, "时间线任务");
// 窗口内只有 run-a（10:00–10:05）；run-b 在 10:30 之后（窗口是 10:00–11:00，也在，
// 但 cancelled）——「该 agent 累计」是**不限窗口**的，页面用它说明窗口外的量。
assert.equal(tl.agentRunCount, 2, "run-a + run-b（不限窗口）");
assert.equal(tl.agentCompletedRounds, 1, "只有 run-a 是 finished");
assert.equal(tl.projectName, "Alpha");
assert.deepEqual(tl.department, { departmentId: "D0001", departmentName: "SRE部门" });
assert.equal(tl.current, true);
assert.equal(tl.from, FROM);
assert.equal(tl.to, TO);
assert.equal(tl.mode, "segments");

// 状态段必须首尾相接且正好覆盖 [from, to]
assert.ok(tl.segments.length > 0, "segments 不为空");
assert.equal(tl.segments[0].start, FROM, "第一段从 from 开始");
assert.equal(tl.segments[tl.segments.length - 1].end, TO, "最后一段到 to 结束");
for (let i = 1; i < tl.segments.length; i++) {
  assert.equal(tl.segments[i].start, tl.segments[i - 1].end, `第 ${i} 段与上一段相接`);
  assert.ok(tl.segments[i].durationMs > 0, "没有零长度段");
  assert.notEqual(tl.segments[i].state, tl.segments[i - 1].state, "相邻段状态不同（已合并）");
}

const stateSpans = (state) =>
  tl.segments.filter((s) => s.state === state).map((s) => [s.start, s.end]);
// thinking：run_started/thinking 组（10:00:01 → 10:01:10），以及被 stall 截断的
// 第二轮（10:30:01 → 10:35:05 = 组末事件 + 5 分钟 stall 上限）
assert.deepEqual(stateSpans("thinking"), [
  [T("10:00:01"), T("10:01:10")],
  [T("10:30:01"), T("10:35:05")],
]);
// working：工具组一直延续到 run 结束事件（10:01:10 → 10:05:00）
assert.deepEqual(stateSpans("working"), [[T("10:01:10"), T("10:05:00")]]);
// idle：兜住窗口两端与 run 之间
assert.deepEqual(stateSpans("idle"), [
  [FROM, T("10:00:01")],
  [T("10:05:00"), T("10:30:01")],
  [T("10:35:05"), TO],
]);

const stalledSegments = tl.segments.filter((s) => s.stalled);
assert.equal(stalledSegments.length, 1, "只有第二轮 thinking 被 stall 截断");
assert.equal(stalledSegments[0].state, "thinking");
assert.equal(stalledSegments[0].end, T("10:35:05"));

// ---- totals ----
assert.equal(tl.totals.thinkingMs, 69_000 + 304_000);
assert.equal(tl.totals.workingMs, 230_000);
assert.equal(tl.totals.idleMs, 3_600_000 - tl.totals.activeMs);
assert.equal(tl.totals.spanMs, 3_600_000);
assert.equal(tl.totals.runCount, 2);
assert.equal(tl.totals.userInputCount, 2);
assert.equal(tl.totals.toolCalls, 3);
assert.equal(tl.totals.modelCalls, 5);
assert.equal(tl.totals.eventCounts.thinking, 2, "窗口内 thinking 计数（09:00 那条在外面）");
assert.equal(tl.totals.eventCounts.user_message, 2);
assert.ok(tl.note.includes("5 分钟"), "口径说明里写明 stall 阈值");

// ---- 用户 input 事件 ----
const inputs = tl.markers.filter((m) => m.kind === "user_input");
assert.equal(inputs.length, 2);
assert.equal(inputs[0].at, T("10:00:00"));
assert.equal(inputs[0].text, "round one");
assert.equal(inputs[0].mode, "agent");
assert.equal(inputs[0].imageCount, 1);
assert.equal(inputs[1].text, "round two");
assert.equal(inputs[1].mode, "plan");
assert.equal(inputs[1].runId, "run-b");
assert.equal(tl.markers.filter((m) => m.kind === "run_start").length, 2);
const ends = tl.markers.filter((m) => m.kind === "run_end");
assert.deepEqual(ends.map((m) => m.status), ["finished", "cancelled"]);
assert.equal(tl.markers.filter((m) => m.kind === "stall").length, 1);

// ---- 每轮 run 的拆解 ----
assert.equal(tl.runs.length, 2);
const runA = tl.runs.find((r) => r.runId === "run-a");
assert.equal(runA.status, "finished");
assert.equal(runA.thinkingMs, 69_000);
assert.equal(runA.workingMs, 230_000);
assert.equal(runA.inputText, "round one");
assert.equal(runA.mode, "agent");
assert.equal(runA.toolCalls, 3);
assert.equal(runA.modelCalls, 4);
assert.equal(runA.model, "gpt-5");
const runB = tl.runs.find((r) => r.runId === "run-b");
assert.equal(runB.status, "cancelled");
assert.equal(runB.inputText, "round two");
assert.equal(runB.thinkingMs, 304_000, "stall 之后算 idle，不再算 thinking");
assert.equal(runB.workingMs, 0);

// ---- 3) 参数兜底 / 404 ----
assert.equal((await timelineOf("cls-unknown")).status, 404);
assert.equal(
  (await timelineOf(AGENT_ONE, "?projectId=project-unknown")).status,
  404,
  "projectId 与 agent 所属项目不符 → 404",
);

// 默认窗口 = 最近 1 小时；老数据都在窗口外 → 整段 idle，但仍然铺满窗口
const nowTl = (await timelineOf(AGENT_ONE)).body;
assert.equal(nowTl.totals.spanMs, 3_600_000);
assert.equal(nowTl.totals.idleMs, 3_600_000);
assert.equal(nowTl.totals.runCount, 0);
assert.equal(nowTl.segments.length, 1);
assert.equal(nowTl.segments[0].state, "idle");

// ---- 3b) 窗口选错了：窗口里一条事件都没有，但必须能说出「这个 agent 最近活跃在……」----
// （前端靠 lastActiveAt 区分「窗口选错了」和「这个 agent 真的没动过」，并给一键跳转。）
assert.equal(nowTl.lastActiveAt, T("10:40:00"), "lastActiveAt 不受查询窗口限制");
assert.ok(
  Date.parse(nowTl.lastActiveAt) < Date.parse(nowTl.from),
  "最近活跃时间早于窗口起点（也就是这个窗口里真的没有事件）",
);
assert.equal(Object.keys(nowTl.totals.eventCounts).length, 0);

const awayTl = (
  await timelineOf(
    AGENT_ONE,
    `?from=${encodeURIComponent("2026-09-02T00:00:00.000Z")}&to=${encodeURIComponent(
      "2026-09-02T01:00:00.000Z",
    )}`,
  )
).body;
assert.equal(Object.keys(awayTl.totals.eventCounts).length, 0);
assert.equal(awayTl.runs.length, 0);
assert.equal(awayTl.markers.length, 0);
assert.equal(awayTl.lastActiveAt, T("10:40:00"));

// 跨度上限 30 天：from 给得很早 → 以 to 为准夹到 30 天
const longTl = (
  await timelineOf(AGENT_ONE, `?from=2020-01-01T00:00:00.000Z&to=${encodeURIComponent(TO)}`)
).body;
assert.equal(longTl.totals.spanMs, 30 * 24 * 3600_000);
assert.equal(longTl.to, TO);

// 非法 from/to → 退回默认窗口
const badTl = (await timelineOf(AGENT_ONE, "?from=nonsense&to=also-bad")).body;
assert.equal(badTl.totals.spanMs, 3_600_000);

// 从没跑过的 agent（task 绑定了它但还没有 run）→ 整段空闲，而不是 404
const AGENT_IDLE = "agent-55555555-5555-5555-5555-555555555555";
const t3 = store.createTask({
  title: "未运行任务",
  workspace: path.join(dataDir, "t3"),
  provider: "cursor",
  projectId: alpha.projectId,
});
store.setTaskAgentId(t3.taskId, AGENT_IDLE);
const idleTl = (
  await timelineOf(AGENT_IDLE, `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)
).body;
assert.equal(idleTl.totals.runCount, 0);
assert.equal(idleTl.totals.idleMs, 3_600_000);
assert.equal(idleTl.segments.length, 1);
// 从没跑过的 agent 也要有个诚实的活跃时间（task 的建立时间），否则页面没法解释
// 「它为什么是空的」——用户在意的就是这个 task 到底动没动过。
assert.equal(idleTl.lastActiveAt, t3.createdAt);
assert.equal(idleTl.segments[0].state, "idle");
assert.equal(idleTl.current, true);
assert.equal(idleTl.taskTitle, "未运行任务");
assert.equal(idleTl.markers.length, 0);

// ---- 4) 跨度太大 → 时间桶模式（不返回几千个 segment）----
const t2 = store.createTask({
  title: "忙碌 agent",
  workspace: path.join(dataDir, "t2"),
  provider: "cline",
  projectId: alpha.projectId,
});
store.setTaskAgentId(t2.taskId, AGENT_BUSY);
recordRun(t2.taskId, AGENT_BUSY, {
  runId: "run-busy",
  createdAt: FROM,
  completedAt: TO,
  durationMs: 3_600_000,
  provider: "cline",
  toolCalls: 1250,
  modelCalls: 1250,
});
addEvent(t2.taskId, "run-busy", AGENT_BUSY, "user_message", FROM, {
  text: "busy",
  mode: "agent",
});
addEvent(t2.taskId, "run-busy", AGENT_BUSY, "run_started", T("10:00:01"), { mode: "agent" });
// 10:00:00 → 11:00:00 每 1.4s 交替 thinking / terminal ≈ 2500 个状态组
const startMs = Date.parse(FROM);
for (let i = 0; i < 2500; i++) {
  addEvent(
    t2.taskId,
    "run-busy",
    AGENT_BUSY,
    i % 2 === 0 ? "thinking" : "terminal",
    new Date(startMs + i * 1400).toISOString(),
    {},
  );
}

const busy = (
  await timelineOf(AGENT_BUSY, `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)
).body;
assert.equal(busy.mode, "buckets");
assert.equal(busy.segments.length, 0, "桶模式不再返回逐段数据");
assert.ok(busy.buckets.length > 0 && busy.buckets.length <= 600);
const bucketMs = busy.buckets.reduce(
  (sum, b) => sum + b.thinkingMs + b.workingMs + b.idleMs,
  0,
);
assert.ok(
  Math.abs(bucketMs - busy.totals.spanMs) <= busy.buckets.length * 2,
  "每个时间桶都被状态铺满（误差只来自毫秒取整）",
);
assert.equal(
  busy.totals.thinkingMs + busy.totals.workingMs + busy.totals.idleMs,
  3_600_000,
);
assert.equal(busy.totals.runCount, 1);
assert.equal(busy.totals.userInputCount, 1);
assert.equal(
  busy.buckets.reduce((n, b) => n + b.userInputs, 0),
  1,
  "用户输入也落到桶里",
);
assert.equal(busy.buckets.reduce((n, b) => n + b.runCount, 0), 1);

// ---- 5) 纯函数口径（与 SQL 用的是同一份映射）----
assert.equal(stateOfEventType("thinking"), "thinking");
assert.equal(stateOfEventType("terminal"), "working");
assert.equal(stateOfEventType("user_message"), "idle");
assert.equal(stateOfEventType("run_completed"), "idle");
const empty = buildAgentTimeline({
  fromIso: FROM,
  toIso: TO,
  groups: [],
  markers: [],
  runs: [],
  eventCounts: {},
});
assert.equal(empty.segments.length, 1);
assert.equal(empty.segments[0].state, "idle");
assert.equal(empty.totals.activeRatio, 0);
// 非法窗口（from >= to）不抛错，返回空时间线
const badWindow = buildAgentTimeline({
  fromIso: TO,
  toIso: FROM,
  groups: [],
  markers: [],
  runs: [],
  eventCounts: {},
});
assert.equal(badWindow.segments.length, 0);
assert.equal(badWindow.totals.spanMs, 0);

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: agent timeline (idle / thinking / working + user input events)");

