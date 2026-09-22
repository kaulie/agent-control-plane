/**
 * 「autonomy 创建的 agent 也要能 chat」：`POST /api/tasks/{我们的 id}/messages` 的两种走向。
 *
 * 口径：
 * - `agentPath=control-plane`（本机 agent）：老行为**逐字不变** —— 起一个本地 run；
 * - `agentPath=autonomy`：这条消息**投递给执行方** —— autonomy 的 `POST /api/tasks` 带 `task_id`
 *   （= 给同一条 task 的那只 agent 追加一条指令，忙则排队，契约 A2④），本机**不跑 run**；
 *   返回 `202 { executor: true, messageId, queueAhead, executorStatus }`。
 *
 * 四条不假装的规矩（本测试逐个钉住）：
 * 1. 执行方只收文字 → 带图 400，且**没有投递**；
 * 2. 投递前先确认执行方真有这条 task（否则它会拿这个 id **新建**一条任务）→ 404，且**没有投递**；
 * 3. 不可达 / 未配置 → 503 + 原文；
 * 4. 投递是**写**：不落我们的库（tasks/runs/events 计数不变）。
 *
 * 用法：npx tsx backend/scripts/test-autonomy-chat.mjs   （或：npm test）
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-autonomy-chat-"));
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

/** 假 autonomy：`getTask` 按 id 给「有 / 没 / 不可达」，`addInstruction` 记录投递。 */
function fakeAutonomy(over = {}) {
  const calls = [];
  return {
    calls,
    url: "http://127.0.0.1:4300",
    async status() {
      return { available: true, url: "http://127.0.0.1:4300", fetchedAt: "x" };
    },
    async listTasks() {
      return { available: true, tasks: [], url: "http://127.0.0.1:4300", fetchedAt: "x" };
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
        task: { task_id: taskId, status: "running" },
        fetchedAt: "x",
      };
    },
    async createTask() {
      calls.push(["createTask"]);
      return { ok: true, taskId: `task-exec-${calls.length}`, agentId: 10001, status: "pending" };
    },
    async addInstruction(input) {
      calls.push(["addInstruction", input]);
      return (
        over.instruction ?? {
          ok: true,
          taskId: input.taskId,
          agentId: 10002,
          status: "pending",
          messageId: 1000010,
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

const post = (url, payload) => app.inject({ method: "POST", url, headers: uiHeaders, payload });
const json = async (res) => JSON.parse(res.body);
const deliveries = () => autonomy.calls.filter((c) => c[0] === "addInstruction");

// ---- 0) 造一条 agentPath=autonomy 的任务（走新入口）----
const created = await json(
  await post("/api/tasks", {
    description: "把 README 补上",
    projectId: PROJECT_ID,
    agentPath: "autonomy",
  }),
);
assert.ok(created.executorTaskId, "交接记下了执行方那侧的 task id");

// ---- 1) autonomy 任务：消息投递给执行方（本机不跑 run）----
{
  const before = counts();
  const deliveriesBefore = deliveries().length;
  const res = await post(`/api/tasks/${created.taskId}/messages`, { message: "  顺便把 CHANGELOG 也加上  " });
  assert.equal(res.statusCode, 202, "投递成功 = 202（不是 201 本地 run）");
  const body = await json(res);
  assert.equal(body.executor, true, "明确回报「这是投递给执行方的」");
  assert.equal(body.executorTaskId, created.executorTaskId, "投给的是执行方那条 task");
  assert.equal(body.messageId, 1000010, "带出它的 message_id");
  assert.equal(body.queueAhead, 0, "带出「它前面还有几条」");
  assert.equal(body.executorStatus, "pending");
  assert.equal(body.runId, undefined, "本机没有 run");

  const said = deliveries().at(-1)[1];
  assert.deepEqual(
    said,
    { taskId: created.executorTaskId, message: "顺便把 CHANGELOG 也加上", mode: "command" },
    "省略 mode → command（老行为：可重规划的指令）",
  );
  assert.equal(body.inputMode, "command");
  assert.equal(deliveries().length, deliveriesBefore + 1, "只投递一次");
  assert.deepEqual(
    autonomy.calls.filter((c) => c[0] === "getTask").at(-1)[1],
    created.executorTaskId,
    "投递前先确认执行方真有这条 task（否则它会拿这个 id 新建任务）",
  );

  const after = counts();
  assert.deepEqual(after, before, "投递是**写**，但写的是执行方：我们的库一行都不动");

  // 投递后，执行方那边状态照旧能读（计划区/状态条靠它刷新）
  const exec = await app.inject({ method: "GET", url: `/api/tasks/${created.taskId}/executor` });
  assert.equal(exec.statusCode, 200);
}

// ---- 2) 执行方只收文字：带图 → 400，且没有投递 ----
{
  const before = deliveries().length;
  const res = await post(`/api/tasks/${created.taskId}/messages`, {
    message: "",
    images: [{ data: "aGk=", mimeType: "image/png" }],
  });
  assert.equal(res.statusCode, 400);
  assert.match((await json(res)).error, /只收文字/, "说清为什么没投递");
  assert.equal(deliveries().length, before, "带图**没有投递**（不是投了再忽略）");
}

// ---- 3) 空文字 → 400，且没有投递 ----
{
  const before = deliveries().length;
  const res = await post(`/api/tasks/${created.taskId}/messages`, { message: "   " });
  assert.equal(res.statusCode, 400);
  assert.equal(deliveries().length, before, "空消息不投递");
}

// ---- 4) 执行方那边没有这条 task → 404 且不投递（防「拿错 id 悄悄造一条新任务」）----
{
  const orphan = await json(
    await post("/api/tasks", {
      description: "交接后执行方把它删了",
      projectId: PROJECT_ID,
      agentPath: "autonomy",
    }),
  );
  store.db
    .prepare("UPDATE tasks SET executor_task_id = ? WHERE task_id = ?")
    .run("task-missing", orphan.taskId);
  const before = deliveries().length;
  const res = await post(`/api/tasks/${orphan.taskId}/messages`, { message: "hello?" });
  assert.equal(res.statusCode, 404);
  assert.match((await json(res)).error, /没有这条任务/, "如实说执行方那边没有它");
  assert.equal(deliveries().length, before, "**没有投递**（否则 autonomy 会新建一条 task）");
}

// ---- 5) 执行方不可达 → 503 原文，且不投递 ----
{
  const down = await json(
    await post("/api/tasks", {
      description: "执行方挂了",
      projectId: PROJECT_ID,
      agentPath: "autonomy",
    }),
  );
  store.db.prepare("UPDATE tasks SET executor_task_id = ? WHERE task_id = ?").run("task-down", down.taskId);
  const before = deliveries().length;
  const res = await post(`/api/tasks/${down.taskId}/messages`, { message: "还在吗" });
  assert.equal(res.statusCode, 503);
  assert.match((await json(res)).error, /ECONNREFUSED/);
  assert.equal(deliveries().length, before, "不可达就不投递（不假装成功）");
}

// ---- 6) 执行方明确拒绝（4xx 原文）→ 原样带出 ----
{
  const app2 = Fastify({ logger: false });
  const rejecting = fakeAutonomy({
    instruction: { ok: false, httpStatus: 400, error: "task is not accepting instructions" },
  });
  await registerRoutes(app2, gateway, providers, {
    dataDir,
    appVersion: APP_VERSION,
    autonomy: rejecting,
    taskEntry: "both",
  });
  const res = await app2.inject({
    method: "POST",
    url: `/api/tasks/${created.taskId}/messages`,
    headers: uiHeaders,
    payload: { message: "再试一次" },
  });
  assert.equal(res.statusCode, 400, "执行方 4xx → 原样 4xx");
  assert.equal(JSON.parse(res.body).error, "task is not accepting instructions", "原文带出");
}

// ---- 7) 没配 autonomy → 503（不静默回落成本机 agent）----
{
  const bare = Fastify({ logger: false });
  await registerRoutes(bare, gateway, providers, { dataDir, appVersion: APP_VERSION });
  const res = await bare.inject({
    method: "POST",
    url: `/api/tasks/${created.taskId}/messages`,
    headers: uiHeaders,
    payload: { message: "hello" },
  });
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /autonomy 未配置/);
}

// ---- 8) 老路径逐字不变：本机 agent 的任务还是起本地 run，且不碰 autonomy ----
{
  const local = await json(
    await post("/api/tasks", { description: "本机任务", projectId: PROJECT_ID }),
  );
  assert.equal(local.executorTaskId, undefined, "默认入口还是本机 agent（没有执行方记录）");
  const beforeAutonomy = autonomy.calls.length;
  const res = await post(`/api/tasks/${local.taskId}/messages`, { message: "改一下" });
  assert.equal(res.statusCode, 200, "本机任务照旧：起一个本地 run");
  const body = await json(res);
  assert.ok(body.runId, "老回包还是 runId");
  assert.equal(body.executor, undefined, "不是投递给执行方的");
  assert.equal(autonomy.calls.length, beforeAutonomy, "本机任务的消息不经过 autonomy");
  assert.equal(deliveries().length, 1, "共享的那只假 autonomy 上只投递成功过一次（上面第 1 项）");
}

// ---- 9) 对账行：按**它那边的 task id** 投递（我们库里没有这个 task 行）----
{
  const before = counts();
  const beforeCalls = autonomy.calls.length;
  const res = await post("/api/autonomy/tasks/task-exec-1/messages", { message: " 接着干  " });
  assert.equal(res.statusCode, 202, "对账行也能投递");
  const body = await json(res);
  assert.equal(body.executor, true);
  assert.equal(body.executorTaskId, "task-exec-1");
  assert.equal(body.messageId, 1000010);
  assert.equal(body.queueAhead, 0);
  assert.deepEqual(
    autonomy.calls.filter((c) => c[0] === "addInstruction").at(-1)[1],
    { taskId: "task-exec-1", message: "接着干", mode: "command" },
    "按它的 task id 投递，内容 trim，默认 command",
  );
  assert.deepEqual(counts(), before, "纯代理：我方库一行都不写");
  assert.ok(autonomy.calls.length > beforeCalls, "走的是 autonomy 那份客户端");

  // 未知 task → 404 且不投递（同一条规矩：别让它把未知 id 当成新建任务）
  const beforeDeliveries = deliveries().length;
  const missing = await post("/api/autonomy/tasks/task-missing/messages", { message: "hi" });
  assert.equal(missing.statusCode, 404);
  assert.match((await json(missing)).error, /没有这条任务/);
  assert.equal(deliveries().length, beforeDeliveries, "未知 task 不投递");

  // 不可达 → 503；空消息 / 带图 → 400（都不投递）
  assert.equal((await post("/api/autonomy/tasks/task-down/messages", { message: "hi" })).statusCode, 503);
  assert.equal((await post("/api/autonomy/tasks/task-exec-1/messages", { message: "   " })).statusCode, 400);
  assert.equal(
    (
      await post("/api/autonomy/tasks/task-exec-1/messages", {
        message: "",
        images: [{ data: "aGk=", mimeType: "image/png" }],
      })
    ).statusCode,
    400,
  );
  assert.equal(deliveries().length, beforeDeliveries, "上面这些（未知 / 不可达 / 空 / 带图）都没有投递");
}

// ---- 10) chat / command：mode 原样投递给执行方；非法 mode 400 且不投递 ----
{
  const before = deliveries().length;
  const chat = await json(
    await post(`/api/tasks/${created.taskId}/messages`, { message: "plan 现在走到哪了", mode: "chat" }),
  );
  assert.equal(chat.executor, true);
  assert.equal(chat.inputMode, "chat");
  assert.deepEqual(deliveries().at(-1)[1], {
    taskId: created.executorTaskId,
    message: "plan 现在走到哪了",
    mode: "chat",
  });

  const cmd = await json(
    await post(`/api/tasks/${created.taskId}/messages`, { message: "改成先写测试", mode: "command" }),
  );
  assert.equal(cmd.inputMode, "command");
  assert.deepEqual(deliveries().at(-1)[1].mode, "command");

  const bad = await post(`/api/tasks/${created.taskId}/messages`, { message: "x", mode: "plan" });
  assert.equal(bad.statusCode, 400);
  assert.match((await json(bad)).error, /chat.*command/);
  assert.equal(deliveries().length, before + 2, "非法 mode 没有投递");

  const recon = await json(
    await post("/api/autonomy/tasks/task-exec-1/messages", { message: "只问一句", mode: "chat" }),
  );
  assert.equal(recon.inputMode, "chat");
  assert.deepEqual(deliveries().at(-1)[1], {
    taskId: "task-exec-1",
    message: "只问一句",
    mode: "chat",
  });
}

// ---- 11) 没配 autonomy → 对账行这条也是 503 ----
{
  const bare2 = Fastify({ logger: false });
  await registerRoutes(bare2, gateway, providers, { dataDir, appVersion: APP_VERSION });
  const res = await bare2.inject({
    method: "POST",
    url: "/api/autonomy/tasks/task-exec-1/messages",
    headers: uiHeaders,
    payload: { message: "hello" },
  });
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /autonomy 未配置/);
}

console.log(
  "PASS: autonomy 任务能 chat（两种寻址都投递给执行方 / chat|command 分流 / 只收文字 / 先确认 task 存在 / 不可达不假装 / 纯代理不写库 / 本机路径不变）",
);
