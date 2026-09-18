/**
 * 透明化（PR-5）单测：
 *
 * 1. 启动简报：**保尾部**（以前的 bug 是整段 `slice(0, 7500)`，超预算先把
 *    「### Recent run outcomes」整段砍掉 —— 实测 20 条用户消息就会触发）；
 * 2. token 估算两个口径（实测 ≈6.4 字符/token；SDK 保守比 3）；
 * 3. `agent_succession` 事件 → 表行：`seeded_tokens`（seed 体量）要落库；
 * 4. 落库 + `GET /api/tasks/:id/agent-successions` 能读回。
 *
 * Usage: npx tsx backend/scripts/test-transparency.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {
  bootstrapEventPayload,
  buildTaskBootstrap,
  buildTaskBootstrapText,
} from "../src/task-context.ts";
import {
  CONSERVATIVE_CHARS_PER_TOKEN,
  MEASURED_CHARS_PER_TOKEN,
  estimateMessagesTokenRange,
  estimateTextTokens,
} from "../src/context/index.ts";
import { AgentGateway, agentSuccessionFromEvent } from "../src/gateway/gateway.ts";
import { Store, DEFAULT_PROJECT_ID } from "../src/store/db.ts";
import { registerRoutes } from "../src/http/routes.ts";

const task = {
  taskId: "task-1",
  title: "透明化",
  status: "active",
  workspace: "/tmp/ws",
  provider: "cline",
  projectId: DEFAULT_PROJECT_ID,
  createdAt: "2026-09-16T00:00:00.000Z",
  prUrl: "https://github.com/kaulie/agent-control-plane/pull/82",
};
const project = {
  projectId: DEFAULT_PROJECT_ID,
  name: "web-cursor",
  gitRepoUrl: "https://github.com/kaulie/agent-control-plane",
  createdAt: "",
  updatedAt: "",
};
const userEvent = (i) => ({
  eventId: `evt-u${i}`,
  taskId: task.taskId,
  runId: `run-${i}`,
  agentId: "cls-1",
  timestamp: `2026-09-18T0${i % 10}:00:00.000Z`,
  eventType: "user_message",
  payload: { text: `msg-${String(i).padStart(2, "0")} ${"x".repeat(380)}` },
});
const run = (i) => ({
  runId: `run-${i}`,
  taskId: task.taskId,
  agentId: "cls-1",
  provider: "cline",
  status: "finished",
  createdAt: `2026-09-18T0${i % 10}:00:00.000Z`,
  result: `result-${String(i).padStart(2, "0")} ${"y".repeat(380)}`,
  modelCalls: 1,
  toolCalls: 1,
});

// ---- 1) 简报：超预算时保尾部，run 结论不能被整段砍 ----
const long = buildTaskBootstrap({
  task,
  project,
  events: Array.from({ length: 20 }, (_, i) => userEvent(i)),
  runs: Array.from({ length: 10 }, (_, i) => run(i)),
});
assert.ok(long.chars <= 7500, `简报不能超过 7500 字符（实际 ${long.chars}）`);
assert.ok(long.text.includes("### Recent run outcomes"), "run 结论段落必须保住（老 bug 就是它被整段砍）");
assert.ok(long.kept.runResults >= 4, `run 结论至少要留下几条（实际 ${long.kept.runResults}）`);
assert.ok(long.text.includes("result-09"), "最新的 run 结论必须在");
assert.ok(long.text.includes("msg-19"), "最新的用户消息必须在");
assert.ok(!long.text.includes("msg-00"), "最老的用户消息应该被丢掉（保尾部）");
assert.equal(long.truncated, true);
assert.ok(long.dropped.userMessages > 0, "要如实记录丢了几条用户消息");
assert.ok(long.text.includes("## Current user message"), "尾部说明必须保留");

// 历史很短 → 全留下、不标截断
const short = buildTaskBootstrap({
  task,
  project,
  events: [
    { ...userEvent(1), payload: { text: "第一条" } },
    { ...userEvent(2), payload: { text: "第二条" } },
  ],
  runs: [{ ...run(3), result: "干完了" }],
});
assert.equal(short.truncated, false);
assert.deepEqual(short.kept, { userMessages: 2, runResults: 1 });
assert.ok(short.text.includes("第一条") && short.text.includes("干完了"));
assert.equal(long.kept.userMessages + long.dropped.userMessages, 20);

// 没历史
const empty = buildTaskBootstrap({ task, project, events: [], runs: [] });
assert.ok(empty.text.includes("(no prior history on this task yet)"));
assert.equal(empty.truncated, false);

// 兼容旧 API
assert.equal(buildTaskBootstrapText({ task, project, events: [], runs: [] }), empty.text);

// ---- 2) token 估算两个口径 ----
assert.equal(MEASURED_CHARS_PER_TOKEN, 6.4);
assert.equal(CONSERVATIVE_CHARS_PER_TOKEN, 3);
assert.equal(estimateTextTokens("x".repeat(6400)), 1000, "实测比：6400 字符 ≈ 1000 tokens");
assert.equal(
  estimateTextTokens("x".repeat(6400), CONSERVATIVE_CHARS_PER_TOKEN),
  Math.ceil(6400 / 3),
  "保守比：估得更多（预警偏早）",
);
assert.equal(estimateTextTokens(""), 0);
const range = estimateMessagesTokenRange([{ k: "x".repeat(6400) }]);
assert.equal(range.tokens, Math.ceil(range.chars / MEASURED_CHARS_PER_TOKEN));
assert.ok(range.tokensUpperBound > range.tokens, "保守上界必须更大");
assert.ok(range.chars >= 6400);

// ---- 3) 简报体检数据（进 run_started 事件）----
const payload = bootstrapEventPayload(short);
assert.equal(payload.bootstrapChars, short.chars);
assert.equal(payload.bootstrapTruncated, false);
assert.equal(payload.bootstrapKeptUserMessages, 2);
assert.equal(payload.bootstrapText, short.text, "原文要带上，页面/接口才能回答「模型看到了什么」");
assert.deepEqual(bootstrapEventPayload(undefined), {});

// ---- 4) agent_succession 事件 → 表行（含 seed 体量）----
const successionEvent = {
  eventId: "evt-s1",
  taskId: task.taskId,
  runId: "run-9",
  agentId: "cls-new",
  timestamp: "2026-09-18T10:00:00.000Z",
  eventType: "agent_succession",
  payload: {
    provider: "cline",
    fromAgentId: "cls-old",
    toAgentId: "cls-new",
    reason: "mode_change",
    fromMode: "yolo",
    toMode: "plan",
    seededMessages: 1630.4,
    seededTokens: 1024000.6,
    seededTokensUpperBound: 2337280,
  },
};
const row = agentSuccessionFromEvent(successionEvent);
assert.equal(row.seededMessages, 1630, "条数向下取整");
assert.equal(row.seededTokens, 1024001, "seed 体量四舍五入落库");
assert.equal(row.reason, "mode_change");
assert.equal(agentSuccessionFromEvent({ ...successionEvent, payload: { reason: "x" } }), undefined, "缺 from/to → 不写表");
assert.equal(
  agentSuccessionFromEvent({ ...successionEvent, payload: { ...successionEvent.payload, reason: "session_unusable" } }).reason,
  "session_unusable",
);
assert.equal(
  agentSuccessionFromEvent({ ...successionEvent, payload: { ...successionEvent.payload, seededTokens: undefined } }).seededTokens,
  undefined,
  "没有估算就不编造",
);

// ---- 5) 落库 + API 读回 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-transparency-"));
const store = new Store(dir);
const created = store.createTask({
  title: "透明化",
  workspace: path.join(dir, "ws"),
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: DEFAULT_PROJECT_ID,
});
store.insertAgentSuccession({ successionId: "asn-1", ...row, taskId: created.taskId });
const listed = store.listAgentSuccessions(created.taskId);
assert.equal(listed.length, 1);
assert.equal(listed[0].seededTokens, 1024001);
assert.equal(listed[0].seededMessages, 1630);
const cols = store.agentSuccessionColumns();
assert.ok(cols.includes("seeded_tokens"), "老库也要补上 seeded_tokens 列");

const providers = {
  has: () => false,
  get default() {
    return { name: "cursor", verifyAuth: async () => ({ ok: true, detail: "" }), listModels: async () => [] };
  },
  list: () => [],
  reconcileAfterRestart: async () => {},
};
const gateway = new AgentGateway(store, providers, { agentWorkspaceRoot: path.join(dir, "ws"), dataDir: dir }, () => {});
const app = Fastify({ logger: false });
await registerRoutes(app, gateway, providers, { dataDir: dir, appVersion: "0.0.0-test" });
const res = await app.inject({ method: "GET", url: `/api/tasks/${created.taskId}/agent-successions` });
assert.equal(res.statusCode, 200);
assert.equal(JSON.parse(res.body).successions[0].seededTokens, 1024001);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: 透明化（简报保尾部 / token 双口径 / seed 体量落库 + API）");
