/**
 * fork 动线（上下文将满时的分流）单测：
 *
 * 起点：会话长到模型窗口就**永久卡死**，所以要在 85% 时给出"换个 task 继续"的出口。
 * 这里守住这几条容易踩坑的规则：
 * - **workspace 必须沿用原目录**（否则丢本地 clone / 未提交改动）；
 * - **provider / model / project / prUrl 必须继承**（`createTask` 的默认 provider 是 cursor，
 *   不显式继承就会把 cline 任务 fork 成 cursor 任务）；
 * - 新 task 记 `forkedFrom`，原 task 时间线留一条 `status: forked`（可审计）；
 * - 历史**不复制事件**，改为在新 task 的简报里带一份（`carried`，带 `[fork:*]` 前缀）。
 *
 * Usage: npx tsx backend/scripts/test-fork-api.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";
import { buildTaskBootstrap } from "../src/task-context.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-fork-"));
const store = new Store(dir);
const project = store.createProject("fork-test");
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
const uiHeaders = { "x-ui-version": "0.0.0-test" };

// ---- 造一个"上下文将满"的原 task：同一个 workspace + 已有 PR + 一些历史 ----
const workspace = path.join(dir, "ws", "task-src");
const source = store.createTask({
  title: "长跑任务",
  workspace,
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: project.projectId,
  createdBy: "gaolei",
});
store.updateTaskPrUrl(source.taskId, "https://github.com/kaulie/agent-control-plane/pull/99");
store.createRun({ runId: "run-s1", taskId: source.taskId, agentId: "cls-1", provider: "cline", model: "deepseek-v4-flash" });
store.appendEvent({
  eventId: "evt-u1",
  taskId: source.taskId,
  runId: "run-s1",
  agentId: "cls-1",
  timestamp: "2026-09-18T09:00:00.000Z",
  eventType: "user_message",
  payload: { text: "把 pdf 那段的解析补上" },
});
store.updateRun("run-s1", {
  status: "finished",
  result: "解析加好了，还剩导出没做",
  usage: { inputTokens: 900000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
});

// ---- 1) fork API ----
const res = await app.inject({
  method: "POST",
  url: `/api/tasks/${source.taskId}/fork`,
  headers: uiHeaders,
  payload: {},
});
assert.equal(res.statusCode, 200, res.body);
const { task: forked, source: echoedSource } = JSON.parse(res.body);
assert.equal(echoedSource.taskId, source.taskId);

assert.notEqual(forked.taskId, source.taskId);
assert.equal(forked.workspace, workspace, "⚠️ workspace 必须沿用原目录");
assert.equal(forked.provider, "cline", "⚠️ provider 必须继承（默认是 cursor）");
assert.equal(forked.model, "deepseek-v4-flash");
assert.equal(forked.projectId, project.projectId);
assert.equal(forked.prUrl, "https://github.com/kaulie/agent-control-plane/pull/99", "PR 要继承，避免重复开");
assert.equal(forked.forkedFrom, source.taskId);
assert.equal(forked.title, "长跑任务 (fork)");
assert.equal(forked.status, "active");

// 自定义标题
const titled = JSON.parse(
  (
    await app.inject({
      method: "POST",
      url: `/api/tasks/${source.taskId}/fork`,
      headers: uiHeaders,
      payload: { title: "长跑任务 · 第二轮" },
    })
  ).body,
);
assert.equal(titled.task.title, "长跑任务 · 第二轮");
assert.equal(titled.task.forkedFrom, source.taskId);

// 404
assert.equal(
  (await app.inject({ method: "POST", url: "/api/tasks/task-nope/fork", headers: uiHeaders, payload: {} })).statusCode,
  404,
);

// ---- 2) 原 task：时间线留痕 + forkedTo 反查 ----
const events = JSON.parse((await app.inject({ method: "GET", url: `/api/tasks/${source.taskId}/events` })).body).events;
const notice = events.filter((e) => e.eventType === "status" && e.payload.status === "forked");
assert.equal(notice.length, 2, "每次 fork 都要在原 task 留一条可见提示");
assert.equal(notice[0].payload.forkedTo, forked.taskId);
assert.match(notice[0].payload.message, /同一个工作区/);
const detail = JSON.parse((await app.inject({ method: "GET", url: `/api/tasks/${source.taskId}` })).body);
assert.deepEqual(detail.forkedTo, [forked.taskId, titled.task.taskId]);

// ---- 3) carried：历史进新 task 的简报（不复制事件） ----
const newTask = store.getTask(forked.taskId);
const carried = gateway.carriedForTask(newTask);
assert.equal(carried.taskId, source.taskId);
assert.equal(carried.title, "长跑任务");
assert.ok(carried.runs.length >= 1);
// 新 task 自己没有事件（历史没被复制）
assert.equal(store.listEvents(forked.taskId, { limit: 10 }).events.length, 0, "历史不复制事件");

const bootstrap = buildTaskBootstrap({
  task: newTask,
  project: store.getProject(project.projectId),
  events: [],
  runs: [],
  carried,
});
assert.match(bootstrap.text, /本任务由 .*「长跑任务」fork 而来/);
assert.match(bootstrap.text, /\[fork:[a-z0-9]+\]\s*\[2026-09-18T09:00:00\.000Z\] 把 pdf 那段的解析补上/);
assert.match(bootstrap.text, /\[fork:[a-z0-9]+\]\s*\[.*\] finished run-s1: 解析加好了/);
assert.ok(bootstrap.carried, "要如实报告带了多少");
assert.equal(bootstrap.carried.taskId, source.taskId);
assert.equal(bootstrap.carried.userMessages, 1);
assert.equal(bootstrap.carried.runResults, 1);
assert.equal(bootstrap.kept.userMessages, 1);
// 不是 fork 来的 task → 没有 carried
assert.equal(gateway.carriedForTask(source), undefined);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: fork 动线（继承 workspace/provider/model/prUrl + 留痕 + carried 简报）");
