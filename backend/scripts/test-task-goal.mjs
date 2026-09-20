/**
 * 任务「目标」（合入主分支 / 合入主分支并部署上线）单测。
 *
 * 守住这几条：
 * 1. **目录就两项**，默认 `merge`；未知值一律拦 400（目标会改变 agent 的动作，不能脏写）；
 * 2. **落库 + 投递**：新建时选的目标进 `tasks.goal`，并写进系统投递的需求消息；
 * 3. **简报**：有目标 → 多一行 `- goal:`，且那句「不要 merge / 不要部署」按目标改写；
 *    老任务（没有目标）→ 简报里没有 `- goal:` 行，并保留原来那句话（老行为不变）；
 * 4. **可修改**：PATCH 换目标 → 时间线留 `task_intent_updated`（写明目标变成什么）；`null` 清空；
 * 5. **fork 继承**目标（否则 fork 出来的 task 会退回「开完 PR 停」）。
 *
 * Usage: npx tsx backend/scripts/test-task-goal.mjs   (或 npm test)
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
import {
  DEFAULT_TASK_GOAL,
  TASK_GOAL_CATALOG,
  TASK_GOAL_IDS,
  isTaskGoal,
  normalizeTaskGoal,
} from "../src/task-goals.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-goal-"));
const store = new Store(dir);
// 简报里「仓库 + 交付目标 + 部署平台」那一段只有在**服务中心注入了仓库**时才渲染
// （见 task-context 的 Workspace isolation：仓库地址只来自服务中心，项目上没有该字段）。
const project = store.createProject("goal-test");
const ORG_SERVICES = {
  available: true,
  orgId: "D0005",
  orgName: "AI研发部",
  items: [{ name: "goal-test", gitRepoUrl: "https://github.com/example/goal-test" }],
  source: "http://127.0.0.1:4240",
  fetchedAt: "2026-09-20T01:00:00.000Z",
};

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
const bootstrapOf = (task) =>
  buildTaskBootstrap({
    task,
    project: store.getProject(task.projectId),
    events: [],
    runs: [],
    orgServices: ORG_SERVICES,
  }).text;

// ---- 1) 目录口径 ----
assert.deepEqual(TASK_GOAL_IDS, ["merge", "deploy"]);
assert.equal(DEFAULT_TASK_GOAL, "merge");
assert.deepEqual(
  TASK_GOAL_CATALOG.map((g) => g.label),
  ["合入主分支", "合入主分支并部署上线"],
);
for (const goal of TASK_GOAL_CATALOG) {
  assert.ok(goal.hint.trim(), `${goal.id} 要有说明`);
  assert.ok(goal.directive.trim(), `${goal.id} 要有给 agent 的交付目标原文`);
}
assert.equal(isTaskGoal("merge"), true);
assert.equal(isTaskGoal("pr_only"), false);
assert.equal(normalizeTaskGoal("deploy"), "deploy");
// 未知 / 空值 = 没目标（不回落到默认值，否则老任务会凭空多出一个动作）
assert.equal(normalizeTaskGoal("refactor"), undefined);
assert.equal(normalizeTaskGoal(undefined), undefined);

// ---- 2) 新建：显式目标落库 + 进投递消息 ----
const mergeRes = await post({
  title: "合入主分支的任务",
  description: "改一行文案。",
  goal: "merge",
  projectId: project.projectId,
});
assert.equal(mergeRes.statusCode, 201, mergeRes.body);
const mergeTask = JSON.parse(mergeRes.body);
assert.equal(mergeTask.goal, "merge");
assert.equal(store.getTask(mergeTask.taskId).goal, "merge", "目标要真的落库");

const mergeMessages = store
  .listEvents(mergeTask.taskId, { limit: 50 })
  .events.filter(
    (e) => e.eventType === "user_message" && e.payload.deliveredBy === "system",
  );
assert.equal(mergeMessages.length, 1);
const mergeText = mergeMessages[0].payload.text;
assert.equal(mergeText, formatTaskIntentMessage(store.getTask(mergeTask.taskId)));
assert.match(mergeText, /目标：合入主分支（merge）/);
assert.ok(mergeText.includes(TASK_GOAL_CATALOG[0].directive), "投递消息要带交付目标原文");
assert.match(mergeText, /不要部署上线/);

const deployRes = await post({
  title: "合入并上线的任务",
  description: "加一个按钮。",
  goal: "deploy",
  projectId: project.projectId,
});
assert.equal(deployRes.statusCode, 201, deployRes.body);
const deployTask = JSON.parse(deployRes.body);
assert.equal(deployTask.goal, "deploy");
const deployText = store
  .listEvents(deployTask.taskId, { limit: 50 })
  .events.filter((e) => e.payload.deliveredBy === "system")[0].payload.text;
assert.match(deployText, /目标：合入主分支并部署上线（deploy）/);
assert.ok(deployText.includes(TASK_GOAL_CATALOG[1].directive));

// 没传 goal → 用默认目标（保证新建的任务都有明确交付目标）
const defaulted = JSON.parse(
  (await post({ title: "默认目标", description: "x", projectId: project.projectId })).body,
);
assert.equal(defaulted.goal, DEFAULT_TASK_GOAL);

// 非法目标必须 400（不能静默回落到默认值）
const badGoal = await post({
  title: "非法目标",
  description: "x",
  goal: "pr_only",
  projectId: project.projectId,
});
assert.equal(badGoal.statusCode, 400);
assert.match(JSON.parse(badGoal.body).error, /unknown goal/);

// 详情 / 列表接口要把目标带出去（面板和列表靠它渲染）
const detail = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/tasks/${mergeTask.taskId}` })).body,
);
assert.equal(detail.task.goal, "merge");
const listed = JSON.parse(
  (
    await app.inject({
      method: "GET",
      url: `/api/tasks?projectId=${project.projectId}`,
    })
  ).body,
);
assert.equal(listed.find((t) => t.taskId === deployTask.taskId).goal, "deploy");


// ---- 3) 简报：目标换了行为约束；老任务保持原样 ----
const mergeBootstrap = bootstrapOf(store.getTask(mergeTask.taskId));
assert.ok(mergeBootstrap.includes("- goal: 合入主分支 (merge)"));
assert.ok(mergeBootstrap.includes("Delivery goal = 合入主分支 (merge)"));
assert.ok(mergeBootstrap.includes("merge it into `main` yourself"));
assert.ok(
  !mergeBootstrap.includes("Do not merge the PR and do not deploy unless the user asks."),
  "有目标时不能再出现「不许 merge」的老约束",
);
// 部署平台这条路的事实说明（不要在 agent 进程里同步跑发版脚本）任何情况都要在
assert.ok(mergeBootstrap.includes("agent-control-plane-deployment"));
assert.ok(mergeBootstrap.includes("Never** run a deploy/restart script"));

const deployBootstrap = bootstrapOf(store.getTask(deployTask.taskId));
assert.ok(deployBootstrap.includes("- goal: 合入主分支并部署上线 (deploy)"));
assert.ok(deployBootstrap.includes("and then deploy it"));

const legacy = store.createTask({
  taskId: "task-legacy",
  title: "老任务",
  workspace: path.join(dir, "ws", "legacy"),
  provider: "cursor",
  projectId: project.projectId,
  description: "老任务没有目标。",
});
const legacyBootstrap = bootstrapOf(legacy);
assert.ok(!legacyBootstrap.includes("- goal:"), "老任务的简报不能多出 goal 行");
assert.ok(!legacyBootstrap.includes("Delivery goal"), "老任务的简报不能多出目标段");
assert.ok(
  legacyBootstrap.includes(
    "- Do not merge the PR and do not deploy unless the user asks. The app itself has **no** deploy entry point:",
  ),
  "老任务保持原来那句约束（行为不变）",
);

// ---- 4) PATCH 换目标 / 清空 ----
const changed = await patch(mergeTask.taskId, { goal: "deploy" });
assert.equal(changed.statusCode, 200, changed.body);
assert.equal(JSON.parse(changed.body).goal, "deploy");
const notes = store
  .listEvents(mergeTask.taskId, { limit: 100 })
  .events.filter((e) => e.payload.status === "task_intent_updated");
assert.equal(notes.length, 1);
assert.match(notes[0].payload.message, /目标 → 合入主分支并部署上线/);
assert.equal(notes[0].payload.goal, "deploy");

assert.equal((await patch(mergeTask.taskId, { goal: "pr_only" })).statusCode, 400);
assert.equal((await patch(mergeTask.taskId, {})).statusCode, 400);
const cleared = JSON.parse((await patch(mergeTask.taskId, { goal: null })).body);
assert.equal(cleared.goal, undefined, "goal=null 清掉目标（回到「开完 PR 即停」）");
assert.ok(
  bootstrapOf(store.getTask(mergeTask.taskId)).includes(
    "Do not merge the PR and do not deploy unless the user asks.",
  ),
  "清掉目标后回到老约束",
);

// ---- 5) fork 继承目标 ----
const forked = gateway.forkTask(deployTask.taskId);
assert.ok(forked);
assert.equal(forked.task.goal, "deploy", "fork 要继承交付目标");
const forkedLegacy = gateway.forkTask("task-legacy");
assert.equal(forkedLegacy.task.goal, undefined, "老任务 fork 出来还是没有目标");

console.log("✅ task-goal OK");
await app.close();

