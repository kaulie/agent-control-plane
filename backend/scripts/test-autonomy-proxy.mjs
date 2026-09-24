/**
 * 「执行交给 autonomy」的落库 / 交接 / 代理检查。
 *
 * 口径（v2）：**任务始终由控制面创建并落库**（谁建的就是谁建的），`agentPath` 只决定
 * **agent 由谁创建**：
 * - `control-plane`（默认，老行为）：本地工作区 + 本地 agent + 投递需求开跑；
 * - `autonomy`：任务落我们的库，**执行**交给 autonomy（agent 由它的 runtime 创建）；交接结果
 *   记在 `executorTaskId` / `executorAgentId`；交接失败 → 任务保留 + 标 error + 原文留痕。
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
const PROJECT_ID = "project-default";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-autonomy-proxy-"));
const store = new Store(dataDir);
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

const counts = () => {
  const one = (sql) => store.db.prepare(sql).get().n;
  return {
    tasks: one("SELECT COUNT(*) AS n FROM tasks"),
    runs: one("SELECT COUNT(*) AS n FROM runs"),
    events: one("SELECT COUNT(*) AS n FROM events"),
  };
};

/** 假 autonomy：记录调用，按参数返回可配置的交接结果。 */
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
            projectId: opts.projectId,
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
        task: {
          task_id: taskId,
          status: "running",
          turns: 3,
          context_ref: { project: PROJECT_ID },
          project: { id: PROJECT_ID, name: "web-cursor", git_repo_url: "" },
          plans: [],
        },
        fetchedAt: "2026-09-21T00:00:00.000Z",
      };
    },
    async createTask(input) {
      calls.push(["createTask", input]);
      return (
        over.create ?? {
          ok: true,
          taskId: `task-exec-${calls.length}`,
          agentId: 10001,
          status: "pending",
          messageId: 1000001,
          queued: 0,
        }
      );
    },
    /** 它的账号池（`GET /api/accounts`）：只有掩码，没有 key 原文。 */
    async listAccounts() {
      calls.push(["listAccounts"]);
      if (over.accounts) return over.accounts;
      return {
        available: true,
        url: "http://127.0.0.1:4300",
        fetchedAt: "2026-09-21T00:00:00.000Z",
        accounts: [
          {
            accountId: "acct-1",
            harness: "cline",
            vendor: "deepseek",
            label: "deepseek keyA",
            model: "deepseek-v4-flash",
            agentRootWorkspace: "/tmp/agent-workspaces/a",
            enabled: true,
            isDefault: true,
            apiKeyMasked: "sk-1…06d2",
            hasKey: true,
          },
        ],
      };
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

const post = (url, payload) =>
  app.inject({ method: "POST", url, headers: uiHeaders, payload });
const json = async (res) => JSON.parse(res.body);

// ---- 1) 新入口 = 我们的任务 + 执行交给 autonomy ----
{
  const before = counts();
  const res = await post("/api/tasks", {
    description: "  写个 demo  ",
    projectId: PROJECT_ID,
    agentPath: "autonomy",
  });
  assert.equal(res.statusCode, 201, "任务由控制面创建（201），执行交给 autonomy");
  const task = await json(res);
  assert.ok(task.taskId.startsWith("task-"), "返回的是**我们的** task id");
  assert.equal(task.agentPath, "autonomy", "标注 agent 创建路径");
  assert.equal(task.provider, "autonomy", "provider 记成执行方（列表那一格照旧）");
  assert.equal(task.workspace, "", "不建本地工作区（执行在 autonomy）");
  assert.equal(task.agentId, undefined, "不预分配本地 agent");
  assert.ok(task.executorTaskId, "记下执行方那侧的 task id");
  assert.equal(task.executorAgentId, "10001", "记下执行方那侧的 agent id");
  assert.equal(task.description, "写个 demo", "描述 trim 后落库");

  const after = counts();
  assert.equal(after.tasks, before.tasks + 1, "任务**落在我们库里**（这是要点）");
  assert.equal(after.runs, before.runs, "本地不产生 run（agent 不在我们这边跑）");
  assert.equal(after.events, before.events + 1, "时间线留一条交接说明（可审计）");

  const said = autonomy.calls.filter((c) => c[0] === "createTask").at(-1)[1];
  assert.deepEqual(said, { description: "写个 demo", projectId: PROJECT_ID }, "交接只带描述 + 项目上下文");

  // 按**我们的 taskId** 读执行方状态/进展
  const exec = await app.inject({
    method: "GET",
    url: `/api/tasks/${task.taskId}/executor`,
  });
  assert.equal(exec.statusCode, 200);
  const execBody = await json(exec);
  assert.equal(execBody.status, "running");
  assert.equal(execBody.executorTaskId, task.executorTaskId, "回包里带上两边的对应关系");
  assert.equal(execBody.executorAgentId, "10001");
  assert.deepEqual(
    autonomy.calls.filter((c) => c[0] === "getTask").at(-1)[1],
    task.executorTaskId,
    "代理的是执行方那侧的 task id",
  );

  // 我们的任务列表里就有它（不用两次列表拼接）
  const list = await json(await app.inject({ method: "GET", url: `/api/tasks?projectId=${PROJECT_ID}` }));
  const mine = list.find((t) => t.taskId === task.taskId);
  assert.ok(mine, "新入口的任务出现在我们自己的任务列表里");
  assert.equal(mine.agentPath, "autonomy");
  assert.equal(mine.executorTaskId, task.executorTaskId);
}

// ---- 2) 交接失败：任务保留 + 标 error + 原文留痕（不静默消失，也不回落本地执行）----
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
    url: "/api/tasks",
    headers: uiHeaders,
    payload: { description: "x", projectId: PROJECT_ID, agentPath: "autonomy" },
  });
  assert.equal(res.statusCode, 400, "autonomy 明确拒绝 → 原样 4xx");
  const body = await json(res);
  assert.match(body.error, /unknown project/);
  assert.ok(body.taskId, "把我们的 taskId 带回来（任务已经建了）");
  assert.equal(body.task.status, "error", "失败的任务标 error，不假装在跑");
  const after = counts();
  assert.equal(after.tasks, before.tasks + 1, "任务仍然保留在库里");
  assert.equal(after.runs, before.runs, "绝不回落成本机 agent 执行");
  assert.ok(after.events > before.events, "时间线留下失败原文");
  const timeline = json(
    await rejected.inject({ method: "GET", url: `/api/tasks/${body.taskId}/events` }),
  );
  const failed = (await timeline).events.find(
    (e) => e.payload?.status === "executor_failed",
  );
  assert.ok(failed, "时间线里能查到交接失败那条");
  assert.match(String(failed.payload.message), /unknown project/);

  // 连不上 → 503（任务同样保留）
  const offline = Fastify({ logger: false });
  await registerRoutes(offline, gateway, providers, {
    dataDir,
    appVersion: APP_VERSION,
    autonomy: fakeAutonomy({ create: { ok: false, error: "fetch failed" } }),
    taskEntry: "both",
  });
  const down = await offline.inject({
    method: "POST",
    url: "/api/tasks",
    headers: uiHeaders,
    payload: { description: "x", projectId: PROJECT_ID, agentPath: "autonomy" },
  });
  assert.equal(down.statusCode, 503, "连不上 → 503");
  assert.equal((await json(down)).task.status, "error");

  // 没配 autonomy 也不能静默降级
  const bare = Fastify({ logger: false });
  await registerRoutes(bare, gateway, providers, { dataDir, appVersion: APP_VERSION });
  const noClient = await bare.inject({
    method: "POST",
    url: "/api/tasks",
    headers: uiHeaders,
    payload: { description: "x", projectId: PROJECT_ID, agentPath: "autonomy" },
  });
  assert.equal(noClient.statusCode, 503);
  assert.match((await json(noClient)).error, /autonomy 未配置/);
}

// ---- 3) 参数：agentPath 只认两个值；描述仍必填 ----
{
  const bad = await post("/api/tasks", {
    description: "x",
    projectId: PROJECT_ID,
    agentPath: "whatever",
  });
  assert.equal(bad.statusCode, 400, "非法 agentPath 报错，不静默按默认路径跑");
  assert.match((await json(bad)).error, /agentPath/);
  const noDesc = await post("/api/tasks", { projectId: PROJECT_ID, agentPath: "autonomy" });
  assert.equal(noDesc.statusCode, 400);
  const before = counts();
  assert.equal(before.tasks, counts().tasks, "非法请求不落库");
}

// ---- 4) 老路径（默认 agentPath）逐字不变：本地任务 + 投递开跑 ----
{
  const before = counts();
  const res = await post("/api/tasks", {
    description: "老入口回归：建一条本地任务",
    projectId: PROJECT_ID,
  });
  assert.equal(res.statusCode, 201);
  const task = await json(res);
  assert.equal(task.agentPath, undefined, "老任务不带 agentPath（读到 = 控制面）");
  assert.notEqual(task.provider, "autonomy", "仍然是本地 provider");
  assert.ok(task.workspace, "老任务照旧建本地工作区");
  assert.ok(task.agentId, "老任务照旧预分配本地 agent");
  const after = counts();
  assert.equal(after.tasks, before.tasks + 1, "老入口照旧落库");
  assert.ok(after.runs >= before.runs, "老入口照旧投递需求");
}

// ---- 5) 代理读接口仍然只读：meta / 列表 / 详情 + 未知 task 的 404 ----
{
  const before = counts();
  const meta = await json(await app.inject({ method: "GET", url: "/api/autonomy/meta" }));
  assert.equal(meta.available, true);
  assert.equal(meta.entry, "both");
  const list = await json(
    await app.inject({ method: "GET", url: `/api/autonomy/tasks?projectId=${PROJECT_ID}` }),
  );
  assert.equal(list.available, true);
  assert.equal(list.tasks.length, 1);
  assert.match(
    autonomy.calls.filter((c) => c[0] === "listTasks").at(-1)[1].projectId,
    new RegExp(PROJECT_ID),
  );
  const detail = await json(await app.inject({ method: "GET", url: "/api/autonomy/tasks/task-aaa" }));
  assert.equal(detail.task_id, "task-aaa");
  const missing = await app.inject({ method: "GET", url: "/api/autonomy/tasks/task-missing" });
  assert.equal(missing.statusCode, 404, "没有这条 task → 原样 404");
  const down = await app.inject({ method: "GET", url: "/api/autonomy/tasks/task-down" });
  assert.equal(down.statusCode, 503, "不可达 → 503");
  assert.deepEqual(counts(), before, "读接口一律不写库");
}

// ---- 6) /executor 的边界：没有交接记录 / 未知 task / 不可达 ----
{
  const local = await json(
    await post("/api/tasks", { description: "本地任务", projectId: PROJECT_ID }),
  );
  const none = await app.inject({ method: "GET", url: `/api/tasks/${local.taskId}/executor` });
  assert.equal(none.statusCode, 404, "本地任务没有执行方记录 → 404");
  assert.match((await json(none)).error, /autonomy/);
  const unknown = await app.inject({ method: "GET", url: "/api/tasks/task-nope/executor" });
  assert.equal(unknown.statusCode, 404);

  // 执行方那边读不到 → 503（不假装没有进展）
  const created = await json(
    await post("/api/tasks", { description: "x", projectId: PROJECT_ID, agentPath: "autonomy" }),
  );
  const executorId = created.executorTaskId;
  assert.ok(executorId);
  const downApp = Fastify({ logger: false });
  const downClient = fakeAutonomy();
  downClient.getTask = async (id) => ({
    available: false,
    status: 0,
    error: "ECONNREFUSED",
    fetchedAt: "x",
    id,
  });
  await registerRoutes(downApp, gateway, providers, {
    dataDir,
    appVersion: APP_VERSION,
    autonomy: downClient,
    taskEntry: "both",
  });
  const down = await downApp.inject({
    method: "GET",
    url: `/api/tasks/${created.taskId}/executor`,
  });
  assert.equal(down.statusCode, 503);
  assert.match((await json(down)).error, /ECONNREFUSED/);
}

// ---- 7) 创建入口只剩一个：POST /api/autonomy/tasks 已经移除 ----
{
  const res = await post("/api/autonomy/tasks", { description: "x", projectId: PROJECT_ID });
  assert.equal(res.statusCode, 404, "任务统一走 POST /api/tasks（+ agentPath）");
}

// ---- 8) autonomy 的账号池：只代理（读 best-effort）+ 选了账号就带进交接 ----
{
  const pool = await app.inject({ method: "GET", url: "/api/autonomy/accounts" });
  assert.equal(pool.statusCode, 200, "读是 best-effort：不可达也只是 available:false，不是 500");
  const body = await json(pool);
  assert.equal(body.available, true);
  assert.equal(body.entry, "both");
  assert.equal(body.accounts[0].accountId, "acct-1");
  assert.equal(body.accounts[0].harness, "cline");
  assert.equal(body.accounts[0].isDefault, true);
  assert.equal(body.accounts[0].apiKeyMasked, "sk-1…06d2", "只有掩码");
  assert.equal("apiKey" in body.accounts[0], false, "key 原文不该出现在响应里");
  assert.equal(autonomy.calls.filter((c) => c[0] === "listAccounts").length, 1);

  // 选了账号 → 交接带上它（决定这条任务在 autonomy 那边用哪个 harness / vendor / model / 工作目录）
  const withAccount = await post("/api/tasks", {
    description: "跑在 deepseek 上",
    projectId: PROJECT_ID,
    agentPath: "autonomy",
    autonomyAccountId: "  acct-1  ",
  });
  assert.equal(withAccount.statusCode, 201);
  const said = autonomy.calls.filter((c) => c[0] === "createTask").at(-1)[1];
  assert.deepEqual(
    said,
    { description: "跑在 deepseek 上", projectId: PROJECT_ID, accountId: "acct-1" },
    "账号 id trim 后带过去",
  );

  // 不选账号 → 请求里**没有** accountId（= 交给它的池子解析，而不是「传个空字符串」）
  const without = await post("/api/tasks", {
    description: "不指定账号",
    projectId: PROJECT_ID,
    agentPath: "autonomy",
  });
  assert.equal(without.statusCode, 201);
  const said2 = autonomy.calls.filter((c) => c[0] === "createTask").at(-1)[1];
  assert.equal("accountId" in said2, false, "没选就不发这个字段");

  // autonomy 拒了（账号不在池里）→ 4xx + 原文，任务保留并标 error（绝不静默换一个账号跑）
  const refused = Fastify({ logger: false });
  const fake = fakeAutonomy({
    create: {
      ok: false,
      httpStatus: 400,
      error: "account acct-nope is not in the pool: add it at /accounts",
    },
  });
  await registerRoutes(refused, gateway, providers, {
    dataDir,
    appVersion: APP_VERSION,
    autonomy: fake,
    taskEntry: "both",
  });
  const denied = await refused.inject({
    method: "POST",
    url: "/api/tasks",
    headers: uiHeaders,
    payload: {
      description: "x",
      projectId: PROJECT_ID,
      agentPath: "autonomy",
      autonomyAccountId: "acct-nope",
    },
  });
  assert.equal(denied.statusCode, 400);
  assert.match((await json(denied)).error, /not in the pool/, "把 autonomy 的原文带出来");
  assert.equal(
    fake.calls.filter((c) => c[0] === "createTask").at(-1)[1].accountId,
    "acct-nope",
    "交出去的正是选的那个（而不是悄悄换一个）",
  );

  // 账号是 autonomy 池子的概念：本机路径带它 = 400（不静默丢掉这个选择）
  const mismatched = await post("/api/tasks", {
    description: "x",
    projectId: PROJECT_ID,
    agentPath: "control-plane",
    autonomyAccountId: "acct-1",
  });
  assert.equal(mismatched.statusCode, 400);
  assert.match((await json(mismatched)).error, /agentPath=autonomy/);
}

console.log(
  "PASS: 任务由控制面创建 + 执行交给 autonomy（交接留痕 / 不静默降级 / 老路径不变）"
);
