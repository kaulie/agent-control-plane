/**
 * 「每个 agent 一个工作区」单测：
 * 新 task 的默认 workspace = `<AgentWorkspaceRoot>/agent-<agentid>`，
 * 目录名**就是**这个 agent 的 id（不再有 `<project>/<taskId>` 那层）。
 *
 * 守住的规则：
 * 1. 目录名 = agent id（`agent-<agentid>`），建任务时就存在（不是等 agent 跑起来）；
 * 2. 预分配：网关先把 agent id 落库并标记 `agentPreallocated`，首个 run 拿它去
 *    **开新会话**（`RunInput.preallocatedAgentId`），而不是 resume；
 * 3. provider 照用这个 id（Cline）→ task.agentId 与目录名始终一致；
 *    provider 自己生成 id（Cursor）→ 网关绑定真实 id，目录名保持预分配值（不搬家）；
 * 4. 会话建起来之后（provider 报回 id）预分配标记清掉 → 下一次 run 走 resume；
 * 5. 显式传 `workspace` 仍然优先；显式建的老 task（store.createTask）行为不变；
 * 6. `../` 之类的脏 id 不能逃出 WorkspaceRoot。
 *
 * Usage: npx tsx backend/scripts/test-agent-workspace.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store, newId } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { buildTaskBootstrap } from "../src/task-context.ts";
import { agentWorkspaceDir, agentWorkspaceDirName } from "../src/config.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-agent-ws-"));
const wsRoot = path.join(dir, "ws");
const store = new Store(dir);
const project = store.createProject("agent-ws-test");


// ---- 0) 目录名规则（纯函数）----
assert.equal(
  agentWorkspaceDirName("agent-7362ceb1-4b5b-4110-9a54-82831b26f9fe"),
  "agent-7362ceb1-4b5b-4110-9a54-82831b26f9fe",
);
assert.equal(
  agentWorkspaceDirName("cls-5f7393dd40a44b06"),
  "agent-5f7393dd40a44b06",
  "provider 前缀统一成 agent-",
);
assert.equal(agentWorkspaceDirName("  "), "agent-unknown");
const escaped = agentWorkspaceDir("../../etc/passwd", wsRoot);
assert.ok(escaped.startsWith(`${wsRoot}${path.sep}`), `脏 id 不能逃出 root：${escaped}`);
assert.equal(
  path.dirname(escaped),
  wsRoot,
  `脏 id 只能落成一个目录名（不能拼出层级）：${escaped}`,
);
assert.equal(agentWorkspaceDir("agent-a1b2", wsRoot), path.join(wsRoot, "agent-a1b2"));

// ---- mock providers ----
/** 记录每次 run 的入参，方便断言「网关给了什么」。 */
const calls = [];
/** Cursor 那种：SDK 自己生成会话 id（预分配 id 用不上）。 */
const cursorProvider = {
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
  async run(input) {
    calls.push({ provider: "cursor", input });
    return {
      status: "finished",
      result: "mock done",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
      agentId: `agent-sdk-${calls.length}`,
    };
  },
  async cancel() {
    return true;
  },
};
/** Cline 那种：宿主可以指定会话 id → 直接采用预分配的 agent id。 */
const clineProvider = {
  name: "cline",
  async verifyAuth() {
    return { ok: true, detail: "mock" };
  },
  async listModels() {
    return [];
  },
  async resolveModel() {
    return undefined;
  },
  async run(input) {
    calls.push({ provider: "cline", input });
    const sessionId =
      input.preallocatedAgentId?.trim() || input.agentId?.trim() || newId("cls");
    await input.onEvent({
      eventId: newId("evt"),
      taskId: input.taskId,
      runId: input.runId,
      agentId: sessionId,
      timestamp: new Date().toISOString(),
      eventType: "status",
      payload: { status: "started" },
    });
    return {
      status: "finished",
      result: "mock done",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
      agentId: sessionId,
    };
  },
  async cancel() {
    return true;
  },
};


const registry = new ProviderRegistry("cline", [clineProvider, cursorProvider]);
const gateway = new AgentGateway(
  store,
  registry,
  { agentWorkspaceRoot: wsRoot, dataDir: dir },
  () => {},
);
const app = Fastify({ logger: false });
await registerRoutes(app, gateway, registry, {
  dataDir: dir,
  appVersion: "0.0.0-test",
});
const post = (body) =>
  app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { "x-ui-version": "0.0.0-test" },
    payload: body,
  });

async function waitForRun(taskId, runId) {
  for (let i = 0; i < 300; i += 1) {
    const run = store.listRuns(taskId).find((r) => r.runId === runId);
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} 没有结束`);
}

// ---- 1) Cline（会用预分配 id）：目录名 = agent id ----
const created = await post({
  title: "工作区目录名",
  description: "新建任务默认工作区应该是 agent-<agentid>。",
  projectId: project.projectId,
});
assert.equal(created.statusCode, 201, created.body);
const clineTask = JSON.parse(created.body);
const preallocated = clineTask.agentId;
assert.ok(
  /^agent-[0-9a-f]{16}$/.test(preallocated),
  `预分配的 agent id 形如 agent-<16hex>，实际 ${preallocated}`,
);
assert.equal(clineTask.agentPreallocated, true, "新建任务要带上「agent id 是预分配的」标记");
assert.equal(
  clineTask.workspace,
  path.join(wsRoot, `agent-${preallocated.slice("agent-".length)}`),
  "默认 workspace = <root>/agent-<agentid>",
);
assert.equal(path.basename(clineTask.workspace), clineTask.agentId, "目录名就是 agent id");
assert.ok(fs.existsSync(clineTask.workspace), "工作区目录建任务时就存在（agent 还没跑）");
assert.ok(fs.statSync(clineTask.workspace).isDirectory());

// 简报里注入的就是这个目录（agent 一开工就知道自己在哪）
const bootstrap = buildTaskBootstrap({
  task: store.getTask(clineTask.taskId),
  project,
  events: [],
  runs: [],
}).text;
assert.ok(
  bootstrap.includes(`- workspace: ${clineTask.workspace}`),
  "简报要注入新的 workspace 路径",
);

const firstRun = store.listRuns(clineTask.taskId)[0];
await waitForRun(clineTask.taskId, firstRun.runId);
const firstCall = calls.find((c) => c.input.runId === firstRun.runId);
assert.ok(firstCall, "provider.run 必须被调用");
assert.equal(firstCall.input.agentId, "", "预分配 id 不能拿去 resume（agentId 要是空）");
assert.equal(
  firstCall.input.preallocatedAgentId,
  preallocated,
  "预分配 id 走 preallocatedAgentId",
);
assert.equal(firstCall.input.cwd, clineTask.workspace, "agent 的 cwd 就是这个工作区");

const afterFirst = store.getTask(clineTask.taskId);
assert.equal(afterFirst.agentId, preallocated, "provider 照用预分配 id → agent id 不变");
assert.equal(afterFirst.agentPreallocated, undefined, "会话建起来了 → 预分配标记清掉");
assert.equal(afterFirst.workspace, clineTask.workspace, "工作区不搬家");
assert.equal(
  store.listRuns(clineTask.taskId)[0].agentId,
  preallocated,
  "run 行也要落到这个 agent id 上（看板/时间线靠它）",
);
assert.equal(
  store
    .listEvents(clineTask.taskId, { limit: 20 })
    .events.filter((e) => e.payload.status === "session_reset").length,
  0,
  "新任务第一轮不能误报「之前绑定的会话不在本进程」（那是老会话才有的事）",
);

// ---- 2) 第二条消息：已经是活会话 → 正常 resume 路径 ----
const sent = await gateway.sendMessage(clineTask.taskId, { text: "继续。" });
await waitForRun(clineTask.taskId, sent.runId);
const secondCall = calls.find((c) => c.input.runId === sent.runId);
assert.equal(secondCall.input.agentId, preallocated, "后续 run 用真实会话 id");
assert.equal(secondCall.input.preallocatedAgentId, undefined, "预分配 id 只用在第一轮");

// ---- 3) Cursor（SDK 自己生成 id）：绑定真实 id，目录名保持预分配值 ----
const cursorCreated = await post({
  title: "Cursor 任务",
  description: "Cursor 的 SDK 自己生成 agent id。",
  projectId: project.projectId,
  provider: "cursor",
});
assert.equal(cursorCreated.statusCode, 201, cursorCreated.body);
const cursorTask = JSON.parse(cursorCreated.body);
const cursorPreallocated = cursorTask.agentId;
assert.equal(cursorTask.workspace, path.join(wsRoot, cursorPreallocated));
const cursorRun = store.listRuns(cursorTask.taskId)[0];
await waitForRun(cursorTask.taskId, cursorRun.runId);
const cursorCall = calls.find((c) => c.input.runId === cursorRun.runId);
assert.equal(cursorCall.input.agentId, "", "预分配 id 不拿去 resume");
assert.equal(cursorCall.input.preallocatedAgentId, cursorPreallocated);

const afterCursor = store.getTask(cursorTask.taskId);
assert.notEqual(afterCursor.agentId, cursorPreallocated, "Cursor 的 SDK id 与预分配 id 不同");
assert.equal(afterCursor.agentPreallocated, undefined, "绑定了真实 id → 标记清掉");
assert.equal(
  afterCursor.workspace,
  cursorTask.workspace,
  "目录名保持预分配值（工作区不搬家）",
);
assert.equal(
  store.listRuns(cursorTask.taskId)[0].agentId,
  afterCursor.agentId,
  "run 行落到真实 SDK id",
);
const cursorSecond = await gateway.sendMessage(cursorTask.taskId, { text: "继续。" });
await waitForRun(cursorTask.taskId, cursorSecond.runId);
assert.equal(
  calls.find((c) => c.input.runId === cursorSecond.runId).input.agentId,
  afterCursor.agentId,
  "第二轮用真实 SDK id（可 resume）",
);

// ---- 4) 显式 workspace 优先；老 task（store 直建）行为不变 ----
const custom = path.join(dir, "custom-ws");
const explicit = JSON.parse(
  (
    await post({
      title: "显式工作区",
      description: "用户指定了 workspace。",
      projectId: project.projectId,
      workspace: custom,
    })
  ).body,
);
assert.equal(explicit.workspace, custom, "显式 workspace 优先");
assert.ok(explicit.agentId?.startsWith("agent-"), "即使指定 workspace，agent id 还是预分配");
assert.ok(fs.existsSync(custom));


const legacy = store.createTask({
  taskId: "task-legacy",
  title: "老任务",
  workspace: path.join(dir, "ws-legacy"),
  provider: "cline",
  projectId: project.projectId,
  description: "老任务（没有预分配 id）。",
});
assert.equal(legacy.agentId, undefined, "store 直建的任务没有预分配 id");
assert.equal(legacy.agentPreallocated, undefined);
const legacyRun = await gateway.sendMessage(legacy.taskId, { text: "跑一下。" });
await waitForRun(legacy.taskId, legacyRun.runId);
const legacyCall = calls.find((c) => c.input.runId === legacyRun.runId);
assert.equal(legacyCall.input.agentId, "", "老任务第一轮也是开会话");
assert.equal(legacyCall.input.preallocatedAgentId, undefined, "老任务没有预分配 id");
assert.ok(store.getTask(legacy.taskId).agentId, "老任务照旧绑定 provider 给的 id");

// ---- 5) fork 仍然沿用同一个工作区（否则丢本地 clone / 未提交改动）----
const forked = gateway.forkTask(clineTask.taskId);
assert.equal(forked.task.workspace, clineTask.workspace, "fork 必须沿用原工作区");
assert.equal(forked.task.agentId, undefined, "fork 不继承源会话（新 task 自己开）");

console.log("✅ agent-workspace OK");
await app.close();
