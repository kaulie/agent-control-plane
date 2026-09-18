/**
 * 上下文体量口径（`backend/src/context/`）单测。
 *
 * 这里最容易搞错的是 **usage 事件的语义**：
 * - cline：值是**本 run 内累计**的 prompt tokens → 单次 prompt = 相邻两条的差；
 * - cursor：值是 **agent 生命周期累计** → 推不出单次体量（必须如实说"未知"）。
 * 起点是 pdf-reader 的真实事故：最后一次调用 prompt = 38,962,680 − 37,916,440 = 1,046,240，
 * 下一次请求就越过 1,048,576 → 永久卡死。
 *
 * Usage: npx tsx backend/scripts/test-context-size.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {
  CONTEXT_ALERT_PERCENT,
  CONTEXT_WARN_PERCENT,
  buildContextSize,
  modelContextLimit,
  rememberModelLimits,
  supportsContextProbe,
} from "../src/context/index.ts";
import { Store, DEFAULT_PROJECT_ID } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";

const sample = (runId, tokens, at) => ({ runId, at, tokens });

// ---- 1) 累计值 → 每次调用的 prompt（Δ），忽略重复 emit ----
const one = buildContextSize({
  provider: "cline",
  model: "deepseek-v4-flash",
  limit: 1_000_000,
  samples: [
    sample("run-a", 1_000, "2026-09-18T10:00:00.000Z"),
    sample("run-a", 2_100, "2026-09-18T10:00:10.000Z"),
    sample("run-a", 3_300, "2026-09-18T10:00:20.000Z"),
    sample("run-a", 3_300, "2026-09-18T10:00:21.000Z"), // 收尾重复 emit
  ],
});
assert.equal(one.available, true);
assert.equal(one.runs.length, 1);
assert.equal(one.runs[0].calls, 3, "重复 emit 要算 1 次调用");
assert.equal(one.runs[0].startTokens, 1_000, "第 1 次调用 = v1");
assert.equal(one.runs[0].endTokens, 1_200, "末次 = v3 − v2");
assert.equal(one.runs[0].growthTokens, 200);
assert.equal(one.tokens, 1_200, "当前体量 = 末次调用的 prompt");
assert.equal(one.percent, 0.1);
assert.equal(one.sampledAt, "2026-09-18T10:00:21.000Z");
assert.deepEqual(one.thresholds, { warn: CONTEXT_WARN_PERCENT, alert: CONTEXT_ALERT_PERCENT });

// ---- 2) 多轮：增量、换会话标记、剩余轮数 ----
// 注意 run 内累计值从 0 起算：v1 = 首调 prompt，v2 − v1 = 第二次调用的 prompt。
// 会话在长：(5,000 → 5,100)、(5,300 → 5,400)；第三轮换了会话（450 → 520）。
const multi = buildContextSize({
  provider: "cline",
  limit: 10_000,
  samples: [
    sample("r1", 5_000, "2026-09-18T09:00:00.000Z"),
    sample("r1", 10_100, "2026-09-18T09:00:10.000Z"),
    sample("r2", 5_300, "2026-09-18T09:10:00.000Z"),
    sample("r2", 10_700, "2026-09-18T09:10:10.000Z"),
    sample("r3", 450, "2026-09-18T09:20:00.000Z"),
    sample("r3", 970, "2026-09-18T09:20:10.000Z"),
  ],
});
assert.deepEqual(multi.runs.map((r) => r.calls), [2, 2, 2]);
assert.deepEqual(
  multi.runs.map((r) => [r.startTokens, r.endTokens, r.growthTokens]),
  [[5_000, 5_100, 100], [5_300, 5_400, 100], [450, 520, 70]],
);
assert.deepEqual(multi.runs.map((r) => r.reset), [false, false, true], "首调骤降 → 标记换会话");
assert.equal(multi.tokens, 520, "当前体量 = 最后一轮的末次 prompt");
assert.equal(multi.avgGrowthTokens, 90, "最近三轮增量 100 / 100 / 70");
assert.equal(multi.estimatedRunsLeft, Math.floor((8_500 - 520) / 90));
assert.equal(multi.percent, 5.2);

// ---- 3) cursor 不可用（不猜数）----
const cursor = buildContextSize({
  provider: "cursor",
  model: "composer-1",
  limit: 200_000,
  samples: [sample("r1", 2_669_314, "2026-09-18T09:00:00.000Z")],
});
assert.equal(cursor.available, false);
assert.equal(cursor.tokens, undefined);
assert.match(cursor.note, /agent 累计值/);
assert.equal(supportsContextProbe("cline"), true);
assert.equal(supportsContextProbe("cursor"), false);

// ---- 4) 没有采样 / 未知窗口 ----
const empty = buildContextSize({ provider: "cline", limit: 1_000, samples: [] });
assert.equal(empty.available, false);
assert.match(empty.note, /还没有带上 usage 的 run/);
const noLimit = buildContextSize({
  provider: "cline",
  samples: [sample("r1", 1_000, "2026-09-18T09:00:00.000Z")],
});
assert.equal(noLimit.available, true);
assert.equal(noLimit.percent, undefined, "窗口未知 → 不给百分比");
assert.equal(noLimit.estimatedRunsLeft, undefined);

// ---- 5) 模型窗口缓存 ----
rememberModelLimits("cline", [
  { id: "deepseek-v4-flash", displayName: "Flash", contextWindow: 1_000_000, maxInputTokens: 1_000_000 },
  { id: "tiny", displayName: "Tiny", contextWindow: 32_000 },
]);
assert.equal(modelContextLimit("cline", "deepseek-v4-flash"), 1_000_000);
assert.equal(modelContextLimit("CLINE", "DeepSeek-V4-Flash"), 1_000_000, "大小写不敏感");
assert.equal(modelContextLimit("cline", "tiny"), 32_000, "没有 maxInputTokens 时用 contextWindow");
assert.equal(modelContextLimit("cline", "deepseek-v4-flash-preview"), 1_000_000, "包含匹配兜底");
assert.equal(modelContextLimit("cline", "unknown"), undefined);
assert.equal(modelContextLimit("cursor", "composer-1"), undefined);

// ---- 6) Store 采样 + API 详情 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-context-"));
const store = new Store(dir);
const task = store.createTask({
  title: "ctx",
  workspace: path.join(dir, "ws"),
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: DEFAULT_PROJECT_ID,
});
const addRun = (runId, at, usageTokens) => {
  store.createRun({ runId, taskId: task.taskId, agentId: "cls-1", provider: "cline", model: "deepseek-v4-flash" });
  usageTokens.forEach((tokens, i) => {
    store.appendEvent({
      eventId: `evt-${runId}-${i}`,
      taskId: task.taskId,
      runId,
      agentId: "cls-1",
      timestamp: at,
      eventType: "usage",
      payload: {},
      usage: { inputTokens: tokens, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: tokens },
    });
  });
  store.updateRun(runId, {
    status: "finished",
    usage: { inputTokens: tokensum(usageTokens), outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  });
};
function tokensum(list) { return list.reduce((a, b) => a + b, 0); }
addRun("run-1", "2026-09-18T09:00:00.000Z", [400_000, 812_000]);
addRun("run-2", "2026-09-18T09:30:00.000Z", [430_000, 866_000]);

const samples = store.listContextUsageSamples(task.taskId);
assert.deepEqual(samples.samples.map((s) => s.tokens), [400_000, 812_000, 430_000, 866_000]);
assert.deepEqual(samples.samples.map((s) => s.runId), ["run-1", "run-1", "run-2", "run-2"]);
assert.equal(samples.latestModel, "deepseek-v4-flash");

const providers = {
  has: () => false,
  get default() {
    return { name: "cursor", verifyAuth: async () => ({ ok: true, detail: "" }), listModels: async () => [] };
  },
  list: () => [],
  reconcileAfterRestart: async () => {},
};
const gateway = new AgentGateway(store, providers, { agentWorkspaceRoot: path.join(dir, "ws"), dataDir: dir }, () => {});
const detail = gateway.getTaskDetail(task.taskId);
assert.equal(detail.context.available, true);
assert.equal(detail.context.tokens, 436_000, "末次 prompt = 866,000 − 430,000");
assert.equal(detail.context.percent, 43.6);
assert.equal(detail.context.limit, 1_000_000, "窗口来自 provider 目录缓存（第 5 步预热过）");
assert.equal(detail.context.runs.length, 2);
assert.deepEqual(detail.context.runs.map((r) => r.growthTokens), [12_000, 6_000]);

const app = Fastify({ logger: false });
await registerRoutes(app, gateway, providers, { dataDir: dir, appVersion: "0.0.0-test" });
const res = await app.inject({ method: "GET", url: `/api/tasks/${task.taskId}` });
assert.equal(res.statusCode, 200);
const body = JSON.parse(res.body);
assert.equal(body.context.available, true);
assert.equal(body.context.tokens, 436_000);
assert.equal(body.context.runs.length, 2);

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: context size（Δ 折算 / 换会话 / 剩余轮数 / cursor 不可用 / API 详情）");
