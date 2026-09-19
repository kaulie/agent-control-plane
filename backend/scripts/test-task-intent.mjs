/**
 * 任务意图（描述 + 类型 + 系统自动投递）单测。
 *
 * 守住产品确认过的五条规则：
 * 1. **描述必填**：新建没有描述 → 400；PATCH 也不允许把描述改成空；
 * 2. **类型是纯标签**：不改变 agent 行为 —— 简报里除了多一行 `- type:`，**没有任何**
 *    行为约束（对比 general 任务的简报，差异只能是那一行 + 任务描述块）；
 * 3. **自动投递**：新建任务后系统自动下发一条需求消息（`deliveredBy: system`，
 *    `kind: task_intent`）并开跑；并发满时进队列而不是失败；
 * 4. **可修改**：PATCH 改标题/类型/描述 + 时间线留 `task_intent_updated` 可审计事件；
 * 5. **fork 继承**意图（老任务没描述时用标题兜底），且**不**自动再投递一次。
 *
 * Usage: npx tsx backend/scripts/test-task-intent.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../src/store/db.ts";
import { AgentGateway, formatTaskIntentMessage } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { buildTaskBootstrap } from "../src/task-context.ts";
import { TASK_TYPE_CATALOG, normalizeTaskType } from "../src/task-types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-intent-"));
const store = new Store(dir);
const project = store.createProject("intent-test");

let runCalls = 0;
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
  async run() {
    runCalls += 1;
    return {
      status: "finished",
      result: "mock done",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
      agentId: "agent-mock",
    };
  },
  async cancel() {
    return true;
  },
};
const registry = new ProviderRegistry("cursor", [provider]);
const gateway = new AgentGateway(
  store,
  registry,
  { agentWorkspaceRoot: path.join(dir, "ws"), dataDir: dir },
  () => {},
);
const app = Fastify({ logger: false });
await registerRoutes(app, gateway, registry, {
  dataDir: dir,
  appVersion: "0.0.0-test",
});
const uiHeaders = { "x-ui-version": "0.0.0-test" };
const post = (body) =>
  app.inject({ method: "POST", url: "/api/tasks", headers: uiHeaders, payload: body });
const patch = (taskId, body) =>
  app.inject({
    method: "PATCH",
    url: `/api/tasks/${taskId}`,
    headers: uiHeaders,
    payload: body,
  });

// ---- 1) 描述必填 ----
const noDesc = await post({ title: "没有描述", projectId: project.projectId });
assert.equal(noDesc.statusCode, 400, "无描述必须被拒");
assert.match(JSON.parse(noDesc.body).error, /description is required/);

const blankDesc = await post({
  title: "空白描述",
  description: "   \n  ",
  projectId: project.projectId,
});
assert.equal(blankDesc.statusCode, 400, "只有空白的描述 = 没描述");

const badType = await post({
  title: "非法类型",
  description: "随便写点什么",
  taskType: "refactor",
  projectId: project.projectId,
});
assert.equal(badType.statusCode, 400, "未知类型必须被拒（避免脏值进库）");
assert.match(JSON.parse(badType.body).error, /unknown taskType/);

// ---- 2) 正常新建 + 系统自动投递 ----
const created = await post({
  title: "导出 CSV 少一列",
  description: "复现：导出报表 → 打开 CSV → 最后一列缺失。期望与页面一致。",
  taskType: "bugfix",
  projectId: project.projectId,
});
assert.equal(created.statusCode, 201, created.body);
const task = JSON.parse(created.body);
assert.equal(task.taskType, "bugfix");
assert.match(task.description, /最后一列缺失/);
assert.ok(task.workspace, "workspace 仍然自动分配");
assert.ok(
  task.workspace.endsWith(path.join("ws", task.agentId)),
  `新任务的 workspace 应该是 <root>/agent-<agentid>，实际 ${task.workspace}`,
);

const events = store.listEvents(task.taskId, { limit: 50 }).events;
const delivered = events.filter(
  (e) => e.eventType === "user_message" && e.payload.deliveredBy === "system",
);
assert.equal(delivered.length, 1, "新建任务必须自动投递一条系统需求消息");
assert.equal(delivered[0].payload.kind, "task_intent");
assert.match(delivered[0].payload.text, /【需求投递】导出 CSV 少一列/);
assert.match(delivered[0].payload.text, /类型：缺陷修复（bugfix）/);
assert.match(delivered[0].payload.text, /最后一列缺失/);

const runs = store.listRuns(task.taskId);
assert.equal(runs.length, 1, "投递要真的开跑（不是只落一条消息）");
assert.ok(
  runs[0].status === "running" ||
    runs[0].status === "finished" ||
    runs[0].status === "error",
  `run 应该已开始，实际 ${runs[0].status}`,
);
assert.equal(runs[0].runId, delivered[0].runId, "这条消息必须属于这次 run");
assert.equal(
  delivered[0].payload.text,
  formatTaskIntentMessage(store.getTask(task.taskId)),
  "投递文本要和模板一致",
);

// 详情接口要带上描述（面板据此渲染）
const detail = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/tasks/${task.taskId}` })).body,
);
assert.equal(detail.task.taskType, "bugfix");
assert.match(detail.task.description, /最后一列缺失/);

// ---- 3) 类型只是标签：简报差异只有 type 行 + 描述块 ----
const seed = (id, extra) =>
  store.createTask({
    taskId: id,
    title: `title-${id}`,
    workspace: path.join(dir, "ws", id),
    provider: "cursor",
    projectId: project.projectId,
    ...extra,
  });
const plain = seed("task-plain");
const featureTask = seed("task-feature", {
  description: "落地 X 能力；验收标准：Y 通过。",
  taskType: "feature",
});
assert.equal(featureTask.taskType, "feature", "store 要落下类型");
assert.match(featureTask.description, /验收标准/);
assert.ok(
  buildTaskBootstrap({ task: featureTask, events: [], runs: [] }).text.includes(
    "- type: 新功能开发 (feature)",
  ),
  "带类型的任务简报里要有 type 行",
);
const bootstrapOf = (task) =>
  buildTaskBootstrap({ task, events: [], runs: [] }).text;
const plainText = bootstrapOf(plain);
// 关键对比：**同一个 task**（id/标题/时间都相同）只变 type 与描述，
// 这样差异里出现的每一行都只能是类型/描述引起的。
const base = store.getTask(plain.taskId);
const generalText = bootstrapOf({ ...base, taskType: "general" });
const labeledText = bootstrapOf({
  ...base,
  taskType: "feature",
  description: "验收标准：Y 通过。",
});
assert.ok(!generalText.includes("- type:"), "general 任务不该多出 type 行（老行为不变）");
assert.ok(!generalText.includes("## 任务描述"));
assert.ok(labeledText.includes("- type: 新功能开发 (feature)"));
assert.ok(labeledText.includes("## 任务描述"));
assert.ok(labeledText.includes("验收标准：Y 通过。"));

// 「类型不改变行为」的硬证据：两边的行差异**恰好**只有这三行，
// 没有任何额外的行为约束/工作方式段落。
const baseLines = new Set(generalText.split("\n"));
const extraLines = labeledText.split("\n").filter((line) => !baseLines.has(line));
assert.deepEqual(
  extraLines,
  ["- type: 新功能开发 (feature)", "## 任务描述", "验收标准：Y 通过。"],
  "类型/描述之外不得改变简报（类型只是标签）",
);
for (const info of TASK_TYPE_CATALOG) {
  assert.deepEqual(
    Object.keys(info).filter((k) => /playbook|rule|behavior/i.test(k)),
    [],
    "类型目录不允许携带行为约束",
  );
}

// ---- 4) 创建后可改（PATCH）----
const renamed = await patch(task.taskId, {
  title: "导出 CSV 缺列",
  description: "已确认：导出时最后一列被丢掉（表头有、数据无）。",
  taskType: "diagnose",
});
assert.equal(renamed.statusCode, 200, renamed.body);
const afterPatch = JSON.parse(renamed.body);
assert.equal(afterPatch.title, "导出 CSV 缺列");
assert.equal(afterPatch.taskType, "diagnose");
assert.match(afterPatch.description, /最后一列被丢掉/);

const patchedEvents = store.listEvents(task.taskId, { limit: 100 }).events;
const intentNotes = patchedEvents.filter(
  (e) => e.eventType === "status" && e.payload.status === "task_intent_updated",
);
assert.equal(intentNotes.length, 1, "改意图要在时间线留一条可审计事件");
assert.match(intentNotes[0].payload.message, /类型 → 问题定位/);
assert.match(intentNotes[0].payload.message, /下一次会话/);

// 描述不许清空；类型必须合法；缺字段要 400；不存在的任务 404
assert.equal((await patch(task.taskId, { description: "  " })).statusCode, 400);
assert.equal((await patch(task.taskId, { taskType: "nope" })).statusCode, 400);
assert.equal((await patch(task.taskId, {})).statusCode, 400);
assert.equal((await patch("task-does-not-exist", { title: "x" })).statusCode, 404);

// 只改类型：描述/标题不动
const onlyType = JSON.parse((await patch(task.taskId, { taskType: "feature" })).body);
assert.equal(onlyType.taskType, "feature");
assert.equal(onlyType.title, "导出 CSV 缺列");
assert.match(onlyType.description, /最后一列被丢掉/);

// ---- 5) fork 继承意图，且不重复投递 ----
const forked = gateway.forkTask(task.taskId);
assert.ok(forked);
assert.equal(forked.task.taskType, "feature", "fork 继承类型");
assert.match(forked.task.description, /最后一列被丢掉/, "fork 继承描述");
assert.equal(
  store.listEvents(forked.task.taskId, { limit: 10 }).events.length,
  0,
  "fork 不自动投递（否则每次 fork 都白烧一轮 run）",
);

// 老任务（没有描述）→ 用标题兜底，保证新 task 一定有描述
const legacy = seed("task-legacy", {});
assert.equal(legacy.description, undefined);
const forkedLegacy = gateway.forkTask("task-legacy");
assert.equal(forkedLegacy.task.description, "title-task-legacy");
assert.equal(forkedLegacy.task.taskType, normalizeTaskType(undefined));
assert.ok(runCalls >= 1, "至少真的调用过 provider.run");

console.log("✅ task-intent OK");
await app.close();

