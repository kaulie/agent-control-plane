/**
 * 两条 prompt **分开独立管理**（走查式断言）：
 *
 * 1. **初始化 system prompt**：只讲**协议**，**不含这条 task 的任何具体信息**（id / 标题 / 工作区路径 /
 *    目标值 / PR / 仓库清单）→ 所以它对所有 task 是同一份（`buildInitSystemPrompt()` 无参）。
 * 2. **task prompt**：这一单的**具体信息**（身份 + 仓库清单 + 需求原文 + 历史 + 本轮消息的引导尾），
 *    且**不带协议**。
 * 3. 两块**互不影响**：改一块不动另一块（存储 / 接口 / provider 入参三处都按这个来）。
 * 4. 合成文本 = 两块 + `PROMPT_SEPARATOR`（provider 没有 system 通道时送它）；体检分开记进
 *    `run_started`（`initSystemPromptSource` / `initSystemPromptChars` / `taskPromptChars`）。
 *
 *   npx tsx --tsconfig backend/tsconfig.json backend/scripts/test-task-prompts.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import {
  bootstrapEventPayload,
  buildInitSystemPrompt,
  buildTaskPrompts,
  MAX_SYSTEM_PROMPT_CHARS,
  PROMPT_SEPARATOR,
} from "../src/task-context.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-prompts-"));
const store = new Store(dir);
const project = store.createProject("prompt-test");
const ORG_SERVICES = {
  available: true,
  orgId: "D0005",
  orgName: "AI研发部",
  items: [
    { name: "agent-control-plane", gitRepoUrl: "https://github.com/kaulie/agent-control-plane.git" },
  ],
  source: "http://127.0.0.1:4240",
  fetchedAt: "2026-09-20T01:00:00.000Z",
};

const task = store.createTask({
  taskId: "task-prompts",
  title: "两条 prompt 分开管理",
  workspace: path.join(dir, "ws", "prompts"),
  provider: "cursor",
  projectId: project.projectId,
  description: "把 system prompt 与 task prompt 分开独立管理。",
  goal: "merge",
  taskType: "feature",
});
store.updateTaskPrUrl(task.taskId, "https://github.com/kaulie/agent-control-plane/pull/999");
const base = store.getTask(task.taskId);
const events = [
  {
    eventId: "evt-1",
    taskId: task.taskId,
    runId: "run-1",
    agentId: "agent-1",
    timestamp: "2026-09-26T01:00:00.000Z",
    eventType: "user_message",
    payload: { text: "先看 panel 那边的两套模板。" },
  },
];
const runs = [
  {
    runId: "run-1",
    taskId: task.taskId,
    agentId: "agent-1",
    provider: "cursor",
    status: "finished",
    createdAt: "2026-09-26T01:05:00.000Z",
    result: "两套模板拉开了。",
    modelCalls: 1,
    toolCalls: 2,
  },
];
const build = (patch, extra) =>
  buildTaskPrompts({
    task: { ...base, ...patch },
    project,
    events,
    runs,
    orgServices: ORG_SERVICES,
    ...extra,
  });

// ---- 1) 模板（system 那半）：一个字的 task 具体信息都没有 ----
const template = buildInitSystemPrompt();
assert.ok(template.includes("初始化 system prompt"), "要写清这块是什么");
assert.ok(template.includes("Your role"));
assert.ok(template.includes("BRANCHING.md"), "git/PR 协议在");
assert.ok(template.includes("Delivery goal"), "交付目标的**规则**（条件表）在");
assert.ok(template.includes("agent-control-plane-deployment"), "部署协议在");
for (const leak of [
  base.taskId,
  base.title,
  base.workspace,
  "- goal:",
  "Existing pull request",
  "Injected git repositories",
  base.description,
]) {
  assert.ok(!template.includes(leak), `system prompt 不能出现这条 task 的具体信息：${leak}`);
}
// 无参 = 与 task 无关：这就是「不含具体信息」的硬证据（同一份字符串对所有 task 都一样）。
assert.equal(buildInitSystemPrompt(), template);

// ---- 2) task 那半：具体信息都在，协议一个都不在 ----
const prompts = build();
assert.equal(prompts.system.source, "template", "没覆盖 → 用模板");
assert.equal(prompts.system.text, template);
assert.equal(prompts.template.system, template);
assert.ok(prompts.task.text.includes(`- taskId: ${base.taskId}`));
assert.ok(prompts.task.text.includes(`- title: ${base.title}`));
assert.ok(prompts.task.text.includes("- type: 新功能开发 (feature)"));
assert.ok(prompts.task.text.includes("- goal: 合入主分支 (merge)"), "目标**值**是具体信息");
assert.ok(prompts.task.text.includes(`- workspace: ${base.workspace}`), "工作区路径是具体信息");
assert.ok(prompts.task.text.includes("Existing pull request"));
assert.ok(prompts.task.text.includes("Injected git repositories"), "仓库清单是具体信息");
assert.ok(prompts.task.text.includes("## 任务描述"));
assert.ok(prompts.task.text.includes("把 system prompt 与 task prompt 分开独立管理。"));
assert.ok(prompts.task.text.includes("## History summary"));
assert.ok(prompts.task.text.includes("### Recent user messages"));
assert.ok(prompts.task.text.includes("## Current user message"));
for (const proto of ["Your role", "BRANCHING.md", "Delivery goal", "deployment platform", "协议"]) {
  assert.ok(!prompts.task.text.includes(proto), `task prompt 不该带协议：${proto}`);
}

// ---- 3) 合成 + 体检（两块分开记）----
assert.equal(
  prompts.bootstrap.text,
  `${prompts.system.text}${PROMPT_SEPARATOR}${prompts.task.text}`,
  "合成文本 = 两块 + 分隔",
);
assert.equal(prompts.bootstrap.prompts.system.source, "template");
assert.equal(prompts.bootstrap.prompts.system.chars, prompts.system.text.length);
assert.equal(prompts.bootstrap.prompts.task.chars, prompts.task.text.length);
const payload = bootstrapEventPayload(prompts.bootstrap);
assert.equal(payload.initSystemPromptSource, "template");
assert.equal(payload.initSystemPromptChars, prompts.system.text.length);
assert.equal(payload.taskPromptChars, prompts.task.text.length);
assert.equal(payload.bootstrapText, prompts.bootstrap.text, "透明化：仍是这次会话的全文");

// ---- 4) 覆盖：task.systemPrompt 生效，且**不碰 task 那半**（两块独立）----
const own = "## 只在这条 task 生效的补充协议\n- 先用 pnpm，别用 npm。";
const withOwn = build({ systemPrompt: own });
assert.equal(withOwn.system.source, "task");
assert.equal(withOwn.system.text, own);
assert.equal(
  withOwn.task.text,
  prompts.task.text,
  "改 system prompt 不能影响 task prompt（这是「独立管理」的核心）",
);
assert.equal(withOwn.template.system, template, "模板那份仍在（面板「恢复模板」要用）");
assert.equal(
  bootstrapEventPayload(withOwn.bootstrap).initSystemPromptSource,
  "task",
  "体检要如实写用的是哪份",
);
// 反过来：改描述（task prompt 那条轴）不动 system 那半。
const withDesc = build({ description: "换个说法的需求原文。" });
assert.equal(withDesc.system.text, prompts.system.text, "改 task prompt 不能影响 system prompt");
assert.ok(withDesc.task.text.includes("换个说法的需求原文。"));
assert.ok(!withDesc.task.text.includes("把 system prompt 与 task prompt 分开独立管理。"));

// ---- 5) 超长：截断到上限并注明 ----
const huge = build({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 500) });

// ---- 6) 接口：GET /prompts 两块分开给；PATCH systemPrompt 只动它自己 ----
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
    return { status: "finished", modelCalls: 0, toolCalls: 0 };
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
await registerRoutes(app, gateway, registry, { dataDir: dir, appVersion: "0.0.0-test" });
const uiHeaders = { "x-ui-version": "0.0.0-test" };
const getPrompts = async (taskId) =>
  app.inject({ method: "GET", url: `/api/tasks/${taskId}/prompts`, headers: uiHeaders });
const patchTask = async (taskId, payload) =>
  app.inject({
    method: "PATCH",
    url: `/api/tasks/${taskId}`,
    headers: uiHeaders,
    payload,
  });

const preview = await getPrompts(base.taskId);
assert.equal(preview.statusCode, 200, preview.body);
const previewBody = JSON.parse(preview.body);
assert.equal(previewBody.systemPrompt.source, "template");
assert.ok(previewBody.systemPrompt.text.includes("Your role"));
assert.ok(!previewBody.systemPrompt.text.includes("- goal:"));
assert.equal(previewBody.systemPrompt.maxChars, MAX_SYSTEM_PROMPT_CHARS);
assert.ok(previewBody.systemPrompt.template.includes("Your role"), "模板文本要给（恢复模板用）");
assert.ok(previewBody.taskPrompt.text.includes("- goal: 合入主分支 (merge)"));
assert.equal(previewBody.taskPrompt.description, base.description, "task prompt 那条轴就是描述");

const patched = await patchTask(base.taskId, { systemPrompt: own });
assert.equal(patched.statusCode, 200, patched.body);
assert.equal(JSON.parse(patched.body).systemPrompt, own, "落库");
// 只改 system prompt 时，描述一个字没动。
assert.equal(store.getTask(base.taskId).description, base.description);
const afterPatch = JSON.parse((await getPrompts(base.taskId)).body);
assert.equal(afterPatch.systemPrompt.source, "task");
assert.equal(afterPatch.systemPrompt.text, own);
assert.equal(afterPatch.taskPrompt.text, previewBody.taskPrompt.text, "task 那半没变");

// 超长 → 400（别让一份巨长的 prompt 把会话预算吃光）
const tooLong = await patchTask(base.taskId, {
  systemPrompt: "y".repeat(MAX_SYSTEM_PROMPT_CHARS + 1),
});
assert.equal(tooLong.statusCode, 400);
assert.match(JSON.parse(tooLong.body).error, /systemPrompt too long/);

// task prompt 那条轴照旧独立可改（描述不允许改成空）
const descPatch = await patchTask(base.taskId, { description: "新描述（task prompt）。" });
assert.equal(descPatch.statusCode, 200, descPatch.body);
assert.equal(store.getTask(base.taskId).systemPrompt, own, "改描述不能把 system prompt 冲掉");

// `null` = 清掉覆盖（回到模板）
const cleared = await patchTask(base.taskId, { systemPrompt: null });
assert.equal(cleared.statusCode, 200, cleared.body);
assert.equal(store.getTask(base.taskId).systemPrompt, undefined, "清掉 = 回模板");
const clearedPreview = JSON.parse((await getPrompts(base.taskId)).body);
assert.equal(clearedPreview.systemPrompt.source, "template");
assert.equal(clearedPreview.systemPrompt.text, template);

// 未知任务 → 404
const missing = await getPrompts("task-nope");
assert.equal(missing.statusCode, 404);

// 改意图后时间线留痕，并分开记两条 prompt 的状态
const notes = store
  .listEvents(base.taskId, { limit: 200 })
  .events.filter((e) => e.payload.status === "task_intent_updated");
assert.ok(notes.length >= 1, "意图更新要留痕");
assert.ok(
  notes.some((n) => n.payload.systemPromptSource === "task"),
  "留痕里要能看出 system prompt 那半用的是哪份",
);

console.log("✅ task prompts OK（协议那半不含具体信息 / 两块互不影响 / 分开落库与透明化）");

assert.ok(
  huge.system.text.length <= MAX_SYSTEM_PROMPT_CHARS,
  `覆盖的那份不能超过上限（实际 ${huge.system.text.length}）`,
);
assert.ok(huge.system.text.includes("已截断"), "截断要注明");
