/**
 * Agent board checks (`GET /api/agents`).
 *
 * 一个 agent = 绑定在 task 上的一个 SDK agent 实例。看板要给出：
 * agentName（agent 自己的名字，独立于 task）/ 所属部门(project 的部门) / project /
 * task 标题 / 累计完成对话轮次 / 最后活跃时间 / 模型 / token 消耗 / 累计工作
 * duration，并且默认只列「当前 agent」，scope=all 时把被 succession 替换掉的 agent
 * 也列出来（各自只统计自己的 run）。
 *
 * Usage: npm run build --workspace backend && node backend/scripts/test-agent-board.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { registerRoutes } from "../dist/http/routes.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-agent-board-"));
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

const board = async (query = "") =>
  JSON.parse(
    (await app.inject({ method: "GET", url: `/api/agents${query}` })).body,
  );
const rowOf = (data, taskId, agentId) =>
  data.rows.find((r) => r.taskId === taskId && r.agentId === agentId);

let seq = 0;
/**
 * Write one run with explicit timestamps (`createRun` stamps "now", which would
 * leave same-millisecond runs unordered).
 */
function recordRun(
  taskId,
  agentId,
  {
    runId,
    model,
    createdAt,
    completedAt,
    durationMs,
    usage,
    modelCalls = 0,
    toolCalls = 0,
    status = "finished",
    provider = "cursor",
  },
) {
  store.createRun({
    runId,
    taskId,
    agentId,
    provider,
    ...(model ? { model } : {}),
    status: "running",
  });
  store.db
    .prepare(`UPDATE runs SET created_at = ? WHERE run_id = ?`)
    .run(createdAt, runId);
  store.updateRun(runId, {
    status,
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(usage ? { usage } : {}),
    modelCalls,
    toolCalls,
  });
  return runId;
}

function addEvent(taskId, runId, agentId, eventType, timestamp, payload = {}) {
  store.appendEvent({
    eventId: `evt-board-${++seq}`,
    taskId,
    runId,
    agentId,
    timestamp,
    eventType,
    payload,
  });
}

const AGENT_ONE = "agent-11111111-1111-1111-1111-111111111111";
const AGENT_TWO = "cls-2222222222222222";
const AGENT_THREE = "agent-33333333-3333-3333-3333-333333333333";
const AGENT_LEGACY = "agent-44444444-4444-4444-4444-444444444444";

const alpha = store.createProject("Alpha", {
  department: { departmentId: "D0001", departmentName: "SRE部门" },
});
const beta = store.createProject("Beta"); // 没有部门

const mkTask = (title, projectId) =>
  store.createTask({
    title,
    workspace: path.join(dataDir, "ws", title),
    provider: "cursor",
    projectId,
  });

// t1：一个 task 上换过 agent（succession），两个 agent 各有自己的 run。
const t1 = mkTask("Fix the flaky test", alpha.projectId);
recordRun(t1.taskId, AGENT_ONE, {
  runId: "run-t1-a",
  model: "gpt-5",
  createdAt: "2026-09-01T10:00:00.000Z",
  completedAt: "2026-09-01T10:00:10.000Z",
  durationMs: 10_000,
  usage: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    totalTokens: 1500,
  },
  modelCalls: 2,
  toolCalls: 3,
});
recordRun(t1.taskId, AGENT_ONE, {
  runId: "run-t1-b",
  createdAt: "2026-09-01T10:05:00.000Z",
  completedAt: "2026-09-01T10:05:20.000Z",
  durationMs: 20_000,
  usage: {
    inputTokens: 2000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2100,
  },
});
// 出错的 run 也是「跑过」，但不计入「累计完成对话轮次」。
recordRun(t1.taskId, AGENT_ONE, {
  runId: "run-t1-e",
  createdAt: "2026-09-01T10:06:00.000Z",
  completedAt: "2026-09-01T10:06:05.000Z",
  durationMs: 5_000,
  status: "error",
});
recordRun(t1.taskId, AGENT_TWO, {
  runId: "run-t1-c",
  model: "claude-4-5",
  createdAt: "2026-09-02T08:00:00.000Z",
  completedAt: "2026-09-02T08:01:00.000Z",
  durationMs: 60_000,
  usage: {
    inputTokens: 5000,
    outputTokens: 1000,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    totalTokens: 6000,
  },
  modelCalls: 4,
  toolCalls: 7,
});
// 正在跑的 run：看板要能标出「运行中」。
recordRun(t1.taskId, AGENT_TWO, {
  runId: "run-t1-d",
  createdAt: "2026-09-02T09:00:00.000Z",
  durationMs: 0,
  status: "running",
});
store.setTaskAgentId(t1.taskId, AGENT_TWO);
store.insertAgentSuccession({
  successionId: "asn-board-1",
  taskId: t1.taskId,
  runId: "run-t1-c",
  provider: "cursor",
  fromAgentId: AGENT_ONE,
  toAgentId: AGENT_TWO,
  reason: "mode_change",
  fromMode: "yolo",
  toMode: "plan",
  seededMessages: 3,
  createdAt: "2026-09-02T07:59:00.000Z",
});
addEvent(
  t1.taskId,
  "run-t1-a",
  AGENT_ONE,
  "agent_response",
  "2026-09-01T10:08:00.000Z",
);
addEvent(
  t1.taskId,
  "run-t1-d",
  AGENT_TWO,
  "agent_response",
  "2026-09-02T09:00:30.000Z",
);

// t2：刚建好、还没跑过（已绑定 agent）—— 也要出现在看板上，指标为 0。
const t2 = mkTask("Brand new agent", beta.projectId);
store.setTaskAgentId(t2.taskId, AGENT_THREE);
store.touchTaskLastUserInput(t2.taskId, "2026-09-03T12:00:00.000Z");

// t3：还没有 agent（没绑也没跑过）—— 不是 agent，看板上不出现。
const t3 = mkTask("No agent yet", alpha.projectId);

// t4：老数据（有 run 但 tasks.agent_id 为空）—— 用最近一次 run 的 agent 兜底。
const t4 = mkTask("Legacy unbound", alpha.projectId);
recordRun(t4.taskId, AGENT_LEGACY, {
  runId: "run-t4-a",
  model: "gpt-5-mini",
  createdAt: "2026-08-30T10:00:00.000Z",
  completedAt: "2026-08-30T10:00:30.000Z",
  durationMs: 30_000,
  usage: {
    inputTokens: 300,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 500,
  },
});

// ---- 1) 默认 scope=current：每个 task 一个「当前 agent」 ----
const current = await board();
assert.equal(current.scope, "current");
assert.equal(current.rows.length, 3, "t1 / t2 / t4 各一行（t3 没有 agent）");
assert.equal(rowOf(current, t3.taskId, ""), undefined);

const t1Row = rowOf(current, t1.taskId, AGENT_TWO);
assert.ok(t1Row, "t1 的当前 agent 是 succession 之后的 AGENT_TWO");
// agent 名称独立于 task：由 agent id 归一化，和 task 标题不是同一个东西。
assert.equal(t1Row.agentName, "cls-22222222");
assert.equal(t1Row.taskTitle, "Fix the flaky test");
assert.notEqual(t1Row.agentName, t1Row.taskTitle);
assert.equal(t1Row.current, true);
assert.equal(t1Row.running, true, "有 running 的 run");
assert.equal(t1Row.provider, "cursor");
assert.equal(t1Row.projectId, alpha.projectId);
assert.equal(t1Row.projectName, "Alpha");
assert.deepEqual(t1Row.department, {
  departmentId: "D0001",
  departmentName: "SRE部门",
});
// token 口径 = input + output（inclusive），且只算这个 agent 自己的 run。
assert.equal(t1Row.tokens.inputTokens, 5000);
assert.equal(t1Row.tokens.outputTokens, 1000);
assert.equal(t1Row.tokens.cacheReadTokens, 200);
assert.equal(t1Row.tokens.totalTokens, 6000);
assert.equal(t1Row.durationMs, 60_000, "累计 duration 只算自己的 run");
assert.equal(t1Row.runCount, 2);
assert.equal(t1Row.completedRounds, 1, "finished 的 run 才算完成轮次（running 不算）");
assert.equal(t1Row.modelCalls, 4);
assert.equal(t1Row.toolCalls, 7);
// 最后活跃时间 = 该 agent 最新事件（不是 run 完成时间）。
assert.equal(t1Row.lastActiveAt, "2026-09-02T09:00:30.000Z");
// task 没有固定 model → 取该 agent 最近一次 run 的 model。
assert.equal(t1Row.model, "claude-4-5");
assert.equal(t1Row.supersededAt, undefined, "当前 agent 没有被替换");

const t2Row = rowOf(current, t2.taskId, AGENT_THREE);
assert.ok(t2Row);
assert.equal(t2Row.department, undefined, "Beta 没有部门");
assert.equal(t2Row.projectName, "Beta");
assert.equal(t2Row.runCount, 0);
assert.equal(t2Row.completedRounds, 0);
assert.equal(t2Row.agentName, "agent-33333333");
assert.equal(t2Row.durationMs, 0);
assert.equal(t2Row.tokens.totalTokens, 0);
assert.equal(t2Row.model, undefined);
assert.equal(t2Row.running, false);
assert.equal(
  t2Row.lastActiveAt,
  "2026-09-03T12:00:00.000Z",
  "没跑过的 agent → 用最近一次用户输入",
);

const t4Row = rowOf(current, t4.taskId, AGENT_LEGACY);
assert.ok(t4Row, "没有 task.agent_id 的老数据用最近 run 的 agent 兜底");
assert.equal(t4Row.current, true);
assert.equal(t4Row.agentName, "agent-44444444");
assert.equal(t4Row.completedRounds, 1);
assert.equal(t4Row.tokens.totalTokens, 500);
assert.equal(t4Row.lastActiveAt, "2026-08-30T10:00:30.000Z");

// ---- 2) scope=all：被 succession 替换掉的 agent 也在，且只算自己的账 ----
const all = await board("?scope=all");
assert.equal(all.scope, "all");
assert.equal(all.rows.length, 4);
assert.equal(
  all.rows.filter((r) => r.taskId === t1.taskId).length,
  2,
  "scope=all 列出 t1 的新旧两个 agent",
);

const oldAgent = rowOf(all, t1.taskId, AGENT_ONE);
assert.ok(oldAgent);
assert.equal(oldAgent.current, false);
assert.equal(oldAgent.agentName, "agent-11111111");
assert.equal(oldAgent.tokens.totalTokens, 3600, "(1000+500) + (2000+100)");
assert.equal(oldAgent.durationMs, 35_000, "10s + 20s + 出错那次 5s");
assert.equal(oldAgent.runCount, 3);
assert.equal(oldAgent.completedRounds, 2, "出错的 run 不算完成轮次");
assert.equal(oldAgent.lastActiveAt, "2026-09-01T10:08:00.000Z");
assert.equal(oldAgent.supersededAt, "2026-09-02T07:59:00.000Z");
assert.equal(oldAgent.supersededReason, "mode_change");
assert.equal(oldAgent.replacedByAgentId, AGENT_TWO);
assert.equal(oldAgent.model, "gpt-5", "老 agent 的 model 来自它自己的 run");
assert.equal(rowOf(all, t1.taskId, AGENT_TWO)?.current, true);

// ---- 3) 汇总 / 筛选项 ----
assert.equal(current.totals.agentCount, 3);
assert.equal(current.totals.runningAgentCount, 1);
assert.equal(current.totals.runCount, 3, "当前 agent：t1 两个 run + t4 一个 run");
assert.equal(current.totals.completedRounds, 2, "t1 的 AGENT_TWO 1 轮 + t4 1 轮");
assert.equal(current.totals.durationMs, 60_000 + 30_000);
assert.equal(current.totals.tokens.totalTokens, 6000 + 0 + 500);

const departments = new Map(
  current.departments.map((d) => [d.departmentId, d]),
);
assert.equal(departments.get("D0001")?.departmentName, "SRE部门");
assert.equal(departments.get("D0001")?.agentCount, 2, "t1 + t4 都在 Alpha");
assert.equal(departments.get("")?.agentCount, 1, "Beta 的项目没有部门");
assert.equal(departments.get("")?.departmentName, "（未设置）");

const projectNames = current.projects.map((p) => p.name);
assert.ok(
  projectNames.includes("Alpha") && projectNames.includes("Beta"),
  "筛选项来自项目列表（含部门）",
);
assert.deepEqual(
  current.projects.find((p) => p.projectId === alpha.projectId)?.department,
  { departmentId: "D0001", departmentName: "SRE部门" },
);

// ---- 4b) task 口径：per-agent 的数字 + 「这个 task 一共做了多少」 ----
// t1 换过 agent：AGENT_ONE 3 次 run（含 1 次出错）/ AGENT_TWO 2 次（1 个还在跑）。
// 单看一行会以为这个 task 只做了 1~2 轮 —— taskTotals 才是整条 task 的账。
const t1Totals = rowOf(current, t1.taskId, AGENT_TWO)?.taskTotals;
assert.ok(t1Totals, "每个 agent 行都带该 task 的累计");
assert.equal(t1Totals.completedRounds, 3, "两个 agent 的 finished run 加起来");
assert.equal(t1Totals.runCount, 5, "含出错 / 进行中");
assert.equal(t1Totals.totalTokens, 3600 + 6000);
assert.equal(t1Totals.durationMs, 35_000 + 60_000);
assert.equal(t1Totals.agentCount, 2, "这个 task 换过 2 个 agent");
assert.equal(rowOf(current, t1.taskId, AGENT_TWO)?.agentCount, 2);

// scope=task：每个 task 一行，数字跨它历史上所有 agent。
const perTask = await board("?scope=task");
assert.equal(perTask.scope, "task");
assert.equal(perTask.rows.length, 3, "t1 / t2 / t4 各一行（t3 没有 agent）");
assert.equal(
  perTask.rows.filter((r) => r.taskScope).length,
  3,
  "这些行代表整个 task，不是某一个 agent",
);
const t1Task = perTask.rows.find((r) => r.taskId === t1.taskId);
assert.ok(t1Task);
assert.equal(t1Task.agentId, "", "task 行不属于某个 agent");
assert.equal(t1Task.agentName, "Fix the flaky test", "task 行显示 task 标题");
assert.equal(t1Task.completedRounds, 3, "task 口径 = 所有 agent 相加");
assert.equal(t1Task.runCount, 5);
assert.equal(t1Task.tokens.totalTokens, 3600 + 6000);
assert.equal(t1Task.durationMs, 95_000);
assert.equal(t1Task.agentCount, 2);
assert.equal(t1Task.currentAgentId, AGENT_TWO, "task 行也指得出当前绑定的 agent");
assert.equal(t1Task.current, false, "task 行本身不是一个 agent 实例");
assert.equal(t1Task.running, true, "有一个 agent 的 run 还在跑");
assert.equal(t1Task.lastActiveAt, "2026-09-02T09:00:30.000Z", "取该 task 所有 agent 里最新的活跃");
const t2Task = perTask.rows.find((r) => r.taskId === t2.taskId);
assert.equal(t2Task?.agentCount, 1, "绑了 agent 但没跑过 → 也算一个 agent");
assert.equal(t2Task?.completedRounds, 0);
assert.equal(t2Task?.lastActiveAt, "2026-09-03T12:00:00.000Z");

// ---- 4) projectId 过滤 / 参数兜底 ----
const betaOnly = await board(`?projectId=${beta.projectId}`);
assert.equal(betaOnly.rows.length, 1);
assert.equal(betaOnly.rows[0].taskId, t2.taskId);
assert.equal(betaOnly.totals.agentCount, 1);
// 未知 scope 回落 current；空白 projectId 等于不过滤。
assert.equal((await board("?scope=nonsense")).scope, "current");
assert.equal((await board("?projectId=%20")).rows.length, current.rows.length);

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(
  "PASS: agent board (agentName, department, rounds, tokens, duration)",
);
