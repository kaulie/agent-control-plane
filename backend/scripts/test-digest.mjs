/**
 * 模型生成 digest（**默认关闭**：`CONTEXT_DIGEST=1` 才开）单测。
 *
 * 两个用途：fork 来的历史做压缩、上下文轮转时给新会话一份长期摘要。
 * 这里守住最容易出事的几条：
 * - **默认不开**（不开就一个模型调用都不该发）；
 * - 生成失败（HTTP 错/抛异常/没有 key）**绝不抛错**，回退原始历史；
 * - 按事件水位缓存（不然每轮都烧一次模型）；
 * - 摘要是**有损变换** → 必须留一条可见的 `status: digest` 事件，且可在详情里读到原文。
 *
 * Usage: npx tsx backend/scripts/test-digest.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, DEFAULT_PROJECT_ID } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { buildDigestPrompt, digestSourceText, generateDigest } from "../src/context/digest.ts";
import { buildTaskBootstrap } from "../src/task-context.ts";

// ---- 1) 纯函数：提示词 & 取源 ----
const prompt = buildDigestPrompt("历史正文");
assert.match(prompt, /历史正文/);
assert.match(prompt, /保留可执行信息/);

const sourceText = digestSourceText({
  taskId: "task-1",
  title: "长跑任务",
  workspace: "/tmp/ws",
  prUrl: "https://github.com/x/y/pull/9",
  events: [
    { eventType: "user_message", timestamp: "2026-09-18T09:00:00.000Z", payload: { text: "第一条要求" } },
    { eventType: "user_message", timestamp: "2026-09-18T10:00:00.000Z", payload: { text: "最新要求" } },
    { eventType: "agent_decision", timestamp: "2026-09-18T09:30:00.000Z", payload: { summary: "选了 MCP 路径" } },
    { eventType: "terminal", timestamp: "2026-09-18T09:31:00.000Z", payload: { result: "不该出现的大段输出" } },
  ],
  runs: [
    { runId: "run-1", status: "finished", createdAt: "2026-09-18T09:05:00.000Z", result: "做完了 A" },
    { runId: "run-2", status: "error", createdAt: "2026-09-18T10:05:00.000Z", error: "A 又坏了" },
  ],
});
assert.match(sourceText, /# 任务/);
assert.match(sourceText, /PR: https:\/\/github\.com\/x\/y\/pull\/9/);
assert.match(sourceText, /最新要求/);
assert.match(sourceText, /选了 MCP 路径/);
assert.match(sourceText, /A 又坏了/);
assert.doesNotMatch(sourceText, /不该出现的大段输出/, "工具输出原文不喂给摘要模型");
// 有界
const huge = digestSourceText({
  taskId: "t",
  title: "x",
  events: Array.from({ length: 50 }, (_, i) => ({
    eventType: "user_message",
    timestamp: `2026-09-18T0${i % 10}:00:00.000Z`,
    payload: { text: `msg-${i} ${"x".repeat(2_000)}` },
  })),
  runs: [],
  maxChars: 5_000,
});
assert.ok(huge.length <= 5_000, `digest 原文要 ≤ maxChars（实际 ${huge.length}）`);
assert.match(huge, /中间省略/);

// ---- 2) generateDigest：成功 / HTTP 错 / 抛异常 / 缺 baseUrl → 都不抛 ----
const okFetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "  摘要正文  " } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const ok = await generateDigest({
  text: "x",
  provider: { modelId: "deepseek-v4-flash", baseUrl: "https://api.example.com/v1" },
  fetchImpl: okFetch,
});
assert.equal(ok.summary, "摘要正文", "要去掉首尾空白");
assert.equal(ok.model, "deepseek-v4-flash");
assert.equal(ok.chars, "摘要正文".length);

let called = 0;
const errFetch = async () => {
  called += 1;
  return new Response("boom", { status: 500 });
};
assert.equal(
  await generateDigest({ text: "x", provider: { modelId: "m", baseUrl: "https://e/v1" }, fetchImpl: errFetch }),
  undefined,
);
assert.equal(called, 1);
const throwFetch = async () => {
  throw new Error("network down");
};
assert.equal(
  await generateDigest({ text: "x", provider: { modelId: "m", baseUrl: "https://e/v1" }, fetchImpl: throwFetch }),
  undefined,
  "网络异常要吞掉",
);
assert.equal(
  await generateDigest({ text: "x", provider: { modelId: "m" }, fetchImpl: okFetch }),
  undefined,
  "没有 baseUrl 就不发请求",
);

// ---- 3) 网关：默认关闭 → 不生成 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-digest-"));
const store = new Store(dir);
const providers = {
  has: () => false,
  get default() {
    return { name: "cursor", verifyAuth: async () => ({ ok: true, detail: "" }), listModels: async () => [] };
  },
  list: () => [],
  reconcileAfterRestart: async () => {},
};
const createGateway = (opts) =>
  new AgentGateway(
    store,
    providers,
    { agentWorkspaceRoot: path.join(dir, "ws"), dataDir: dir, ...opts },
    () => {},
  );
const source = store.createTask({
  title: "要 fork 的任务",
  workspace: path.join(dir, "ws"),
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: DEFAULT_PROJECT_ID,
});
store.appendEvent({
  eventId: "evt-1",
  taskId: source.taskId,
  runId: "run-1",
  agentId: "cls-1",
  timestamp: "2026-09-18T09:00:00.000Z",
  eventType: "user_message",
  payload: { text: "把 A 做完" },
});
store.createRun({ runId: "run-1", taskId: source.taskId, agentId: "cls-1", provider: "cline" });

const summaryText = "交接摘要：A 已做完，B 未开始";

let fetches = 0;
const countingFetch = async () => {
  fetches += 1;
  return new Response(JSON.stringify({ choices: [{ message: { content: summaryText } }] }), {
    status: 200,
  });
};
const off = createGateway({ digest: { model: "deepseek-v4-flash", baseUrl: "https://e/v1", fetchImpl: countingFetch } });
assert.equal(await off.contextDigestFor(source), undefined, "默认关闭：不生成");
assert.equal(fetches, 0, "默认关闭：一个模型调用都不该发");

// ---- 4) 打开：生成 + 缓存 + 事件留痕 + 详情可读 ----
const on = createGateway({
  contextDigest: true,
  digest: { model: "deepseek-v4-flash", baseUrl: "https://e/v1", fetchImpl: countingFetch },
});
const first = await on.contextDigestFor(source);
assert.equal(first.text, summaryText);
assert.equal(first.sourceTaskId, source.taskId);
assert.equal(first.model, "deepseek-v4-flash");
assert.equal(fetches, 1);
// 生成这件事必须可见
const digestEvents = store
  .listEvents(source.taskId, { limit: 20 })
  .events.filter((e) => e.eventType === "status" && e.payload.status === "digest");
assert.equal(digestEvents.length, 1, "要留一条 status: digest");
assert.match(String(digestEvents[0].payload.message), /已生成会话摘要/);
assert.equal(digestEvents[0].payload.digestChars, summaryText.length);
// 缓存：水位没动 → 不再调模型
const second = await on.contextDigestFor(source);
assert.equal(second.text, first.text);
assert.equal(fetches, 1, "水位内的第二次不该再调模型");
// 详情里能读到原文（透明化）
assert.equal(on.getTaskDetail(source.taskId).contextDigest.text, summaryText);

// ---- 5) 有摘要时简报用摘要替代原始 carried 行 ----
const forked = store.createTask({
  title: "要 fork 的任务 (fork)",
  workspace: source.workspace,
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: DEFAULT_PROJECT_ID,
  forkedFrom: source.taskId,
});
const carried = on.carriedForTask(store.getTask(forked.taskId));
const withDigest = buildTaskBootstrap({
  task: store.getTask(forked.taskId),
  project: store.getProject(DEFAULT_PROJECT_ID),
  events: [],
  runs: [],
  carried,
  digest: { text: first.text, sourceTaskId: source.taskId, at: "2026-09-18T11:00:00.000Z", model: "deepseek-v4-flash" },
});
assert.match(withDigest.text, /## Session digest（模型生成摘要/);
assert.match(withDigest.text, /交接摘要：A 已做完/);
assert.match(withDigest.text, /完整历史见/);
assert.doesNotMatch(withDigest.text, /\[fork:/, "有摘要就不再塞原始 carried 行（这才是压缩）");
assert.equal(withDigest.digestMeta.chars, summaryText.length);
const payload = buildTaskBootstrap({ task: store.getTask(forked.taskId), events: [], runs: [], carried });
assert.ok(payload.text.includes("[fork:"), "没摘要时仍然带原始历史");

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: 模型 digest（默认关 / 失败回退 / 水位缓存 / 留痕可读 / 替代 carried）");
