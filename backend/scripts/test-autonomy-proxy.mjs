/**
 * 「交给 autonomy」入口的代理检查（`/api/autonomy/*`）。
 *
 * 三条硬约束：
 * 1. **不落库**：走新入口**不写** task/run/event（控制面只代理）—— 每次调用后都断言库里的计数不变；
 * 2. **不静默降级**：autonomy 拒绝 → 原样 4xx + 它的原文；连不上 / 超时 → 503（绝不假装成功、
 *    也绝不回落成本机 agent 执行）；
 * 3. **老入口零影响**：`POST /api/tasks` 依旧建本地任务（回归防线）。
 *
 * 用法：npx tsx backend/scripts/test-autonomy-proxy.mjs   （或：npm test）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";

const APP_VERSION = "0.0.0-test";
const uiHeaders = { "x-ui-version": APP_VERSION };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-autonomy-proxy-"));
const store = new Store(dataDir);
/**
 * 只实现 registerRoutes / AgentGateway 会碰到的部分。
 *
 * 这里比别的测试多一层：第 9 段要验**老入口** `POST /api/tasks` 仍能建本地任务，
 * 所以 provider 必须「名字合法」；`run()` 直接抛错即可 —— 网关会把 run 记成 error
 * （run 错误是一等公民），不会影响任务已创建这件事。
 */
const fakeProvider = {
  name: "cursor",
  verifyAuth: async () => ({ ok: true, detail: "" }),
  listModels: async () => [],
  run: async () => {
    throw new Error("test: provider run not implemented");
  },
  cancel: async () => true,
};
const providers = {
  has: () => true,
  names: () => ["cursor", "cline"],
  defaultProviderName: "cursor",
  get: () => fakeProvider,
  get default() {
    return fakeProvider;
  },
  list: () => [fakeProvider],
  reconcileAfterRestart: async () => {},
};
const gateway = new AgentGateway(
  store,
  providers,
  { agentWorkspaceRoot: path.join(dataDir, "ws"), dataDir },
  () => {},
);

/** 库里到底有没有为此写过东西（「不落库」的证据）。 */
const counts = () => {
  const one = (sql) => store.db.prepare(sql).get().n;
  return {
    tasks: one("SELECT COUNT(*) AS n FROM tasks"),
    runs: one("SELECT COUNT(*) AS n FROM runs"),
    events: one("SELECT COUNT(*) AS n FROM events"),
  };
};

/** 假 autonomy：记录调用，按参数返回可配置结果。 */
function fakeAutonomy(over = {}) {
  const calls = [];
  return {
    calls,
    url: "http://127.0.0.1:4300",
    async status() {
      calls.push(["status"]);
      return {
        available: true,
        url: "http://127.0.0.1:4300",
        version: "ff9899c0",
        llmBackend: "cline",
        llmModel: "deepseek-v4-flash",
        turns: 3,
        fetchedAt: "2026-09-21T00:00:00.000Z",
      };
    },
    async listTasks(opts = {}) {
      calls.push(["listTasks", opts]);
      return {
        available: true,
        url: "http://127.0.0.1:4300",
        fetchedAt: "2026-09-21T00:00:00.000Z",
        tasks: [
          {
            id: "task-aaa",
            description: "d",
            status: "running",
            turns: 2,
            lastAt: "2026-09-21T00:00:00Z",
            projectId: "project-59c41b54",
            agentId: 10000,
            updatedAt: "2026-09-21T00:00:01Z",
          },
        ],
      };
    },
    async getTask(taskId) {
      calls.push(["getTask", taskId]);
      if (taskId === "task-missing") {
        return { available: false, status: 404, error: "task not found", fetchedAt: "x" };
      }
      if (taskId === "task-down") {
        return { available: false, status: 0, error: "ECONNREFUSED", fetchedAt: "x" };
      }
      return {
        available: true,
        status: 200,
        task: { task_id: taskId, status: "blocked", context_ref: { project: "project-59c41b54" }, plans: [] },
        fetchedAt: "2026-09-21T00:00:00.000Z",
      };
    },
    async createTask(input) {
      calls.push(["createTask", input]);
      return (
        over.create ?? {
          ok: true,
          taskId: "task-new",
          agentId: 10000,
          status: "pending",
          messageId: 1000001,
          queued: 0,
        }
      );
    },
  };
}

const autonomy = fakeAutonomy();
const app = Fastify({ logger: false });
await registerRoutes(app, gateway, providers, {
  dataDir,
  appVersion: APP_VERSION,
  autonomy,
  taskEntry: "both",
});

const get = (url) => app.inject({ method: "GET", url });
const json = async (res) => JSON.parse(res.body);

// ---- 1) meta：可用性 + 版本 + 入口开关 ----
{
  const res = await get("/api/autonomy/meta");
  assert.equal(res.statusCode, 200);
  const body = await json(res);
  assert.equal(body.available, true);
  assert.equal(body.version, "ff9899c0");
  assert.equal(body.llmBackend, "cline");
  assert.equal(body.entry, "both", "入口开关透给前端");
  assert.equal(body.url, "http://127.0.0.1:4300", "页面上要能写清数据源");
}

// ---- 2) 列表：透传 projectId（页面按当前项目过滤）----
{
  const res = await get("/api/autonomy/tasks?projectId=project-59c41b54");
  assert.equal(res.statusCode, 200);
  const body = await json(res);
  assert.equal(body.available, true);
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].projectId, "project-59c41b54");
  assert.deepEqual(
    autonomy.calls.filter((c) => c[0] === "listTasks").at(-1)[1],
    { projectId: "project-59c41b54" },
  );
  const noFilter = await json(await get("/api/autonomy/tasks"));
  assert.equal(noFilter.tasks.length, 1);
  assert.equal(
    autonomy.calls.filter((c) => c[0] === "listTasks").at(-1)[1].projectId,
    undefined,
    "不带 projectId 时不加过滤",
  );
}

// ---- 3) 详情：200 原样透传 / 404 原样透传 / 不可达 → 503 ----
{
  const ok = await get("/api/autonomy/tasks/task-aaa");
  assert.equal(ok.statusCode, 200);
  const okBody = await json(ok);
  assert.equal(okBody.task_id, "task-aaa");
  assert.equal(okBody.status, "blocked");
  assert.equal(okBody.fetchedAt, "2026-09-21T00:00:00.000Z", "带上代理读到的时刻");

  const missing = await get("/api/autonomy/tasks/task-missing");
  assert.equal(missing.statusCode, 404, "没有这条 task → 原样 404");
  assert.equal((await json(missing)).error, "task not found");

  const down = await get("/api/autonomy/tasks/task-down");
  assert.equal(down.statusCode, 503, "不可达 → 503（不是 404，也不是 200 空）");
  assert.equal((await json(down)).error, "ECONNREFUSED");
}

// ---- 4) 新入口创建：202 + 不落库 ----
{
  const before = counts();
  const res = await app.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    headers: uiHeaders,
    payload: { description: "  写个 demo  ", projectId: "project-59c41b54" },
  });
  assert.equal(res.statusCode, 202, "受理 = 202（由 autonomy 执行）");
  const body = await json(res);
  assert.equal(body.taskId, "task-new");
  assert.equal(body.agentId, 10000);
  assert.equal(body.queued, 0);
  assert.equal(body.entry, "both");
  assert.equal(body.url, "http://127.0.0.1:4300");
  assert.deepEqual(
    autonomy.calls.filter((c) => c[0] === "createTask").at(-1)[1],
    { description: "写个 demo", projectId: "project-59c41b54" },
    "描述 trim 后交给 autonomy",
  );
  assert.deepEqual(counts(), before, "新入口**不落库**：task/run/event 计数必须不变");
}

// ---- 5) 描述必填 & 超长：本地就拦（不打 autonomy）----
{
  const callsBefore = autonomy.calls.length;
  const empty = await app.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    headers: uiHeaders,
    payload: { description: "   " },
  });
  assert.equal(empty.statusCode, 400);
  const tooLong = await app.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    headers: uiHeaders,
    payload: { description: "x".repeat(20000) },
  });
  assert.equal(tooLong.statusCode, 400);
  assert.equal(autonomy.calls.length, callsBefore, "本地校验失败不该打 autonomy");
}

// ---- 6) 写守卫：缺 x-ui-version 的写请求被拒（与其它写接口一致）----
{
  const res = await app.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    payload: { description: "x" },
  });
  assert.equal(res.statusCode, 428, "写接口要 x-ui-version");
}

// ---- 7) autonomy 拒绝 → 原样 4xx；连不上 → 503；都不回落成本机执行 ----
{
  const rejected = Fastify({ logger: false });
  const fake = fakeAutonomy({
    create: { ok: false, httpStatus: 400, error: "unknown project project-nope" },
  });
  await registerRoutes(rejected, gateway, providers, {
    dataDir,
    appVersion: APP_VERSION,
    autonomy: fake,
    taskEntry: "both",
  });
  const before = counts();
  const res = await rejected.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    headers: uiHeaders,
    payload: { description: "x", projectId: "project-nope" },
  });
  assert.equal(res.statusCode, 400, "autonomy 明确拒绝 → 原样 400");
  assert.equal((await json(res)).error, "unknown project project-nope", "原文带出给用户");
  assert.deepEqual(counts(), before, "被拒也不能在本机建任务");

  const offline = Fastify({ logger: false });
  await registerRoutes(offline, gateway, providers, {
    dataDir,
    appVersion: APP_VERSION,
    autonomy: fakeAutonomy({ create: { ok: false, error: "fetch failed" } }),
    taskEntry: "both",
  });
  const down = await offline.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    headers: uiHeaders,
    payload: { description: "x" },
  });
  assert.equal(down.statusCode, 503, "连不上 → 503");
  assert.equal((await json(down)).error, "fetch failed");
  assert.deepEqual(counts(), before, "不可达也不能在本机建任务（不静默降级）");
}

// ---- 8) 没配 autonomy：读降级为 available:false，写 503 ----
{
  const bare = Fastify({ logger: false });
  await registerRoutes(bare, gateway, providers, { dataDir, appVersion: APP_VERSION });
  const meta = await json(await bare.inject({ method: "GET", url: "/api/autonomy/meta" }));
  assert.equal(meta.available, false);
  assert.match(meta.error, /未配置/);
  const list = await json(await bare.inject({ method: "GET", url: "/api/autonomy/tasks" }));
  assert.equal(list.available, false);
  assert.deepEqual(list.tasks, []);
  const post = await bare.inject({
    method: "POST",
    url: "/api/autonomy/tasks",
    headers: uiHeaders,
    payload: { description: "x" },
  });
  assert.equal(post.statusCode, 503);
}

// ---- 9) 回归：老入口 `POST /api/tasks` 照旧建本地任务 ----
{
  const before = counts();
  const res = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: uiHeaders,
    payload: { description: "老入口回归：建一条本地任务", projectId: "project-default" },
  });
  assert.equal(res.statusCode, 201, "老入口仍是 201 + 本地任务");
  const task = await json(res);
  assert.ok(task.taskId.startsWith("task-"));
  const after = counts();
  assert.equal(after.tasks, before.tasks + 1, "老入口照旧落库");
  assert.ok(after.runs >= before.runs, "老入口照旧投递需求");
}

console.log("PASS: autonomy 代理入口（不落库 / 不静默降级 / 老入口零影响）");
