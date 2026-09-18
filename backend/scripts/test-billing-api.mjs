/**
 * HTTP-level checks for the billing module:
 *   GET/PUT/DELETE /api/billing/rules（含 x-ui-version 写守卫）
 *   GET /api/tasks/:id → stats 里两个成本口径（计费表本币 / SDK 上报美元）
 *
 * Usage: npm run build --workspace backend && node backend/scripts/test-billing-api.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store, DEFAULT_PROJECT_ID } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { registerRoutes } from "../dist/http/routes.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-billing-api-"));
const store = new Store(dataDir);
/** Only the bits registerRoutes / AgentGateway touch for these routes. */
const providers = {
  has: () => false,
  get default() {
    return { name: "cursor", verifyAuth: async () => ({ ok: true, detail: "" }), listModels: async () => [] };
  },
  list: () => [],
  reconcileAfterRestart: async () => {},
};
const gateway = new AgentGateway(
  store,
  providers,
  { agentWorkspaceRoot: path.join(dataDir, "ws"), dataDir },
  () => {},
);
const app = Fastify({ logger: false });
await registerRoutes(app, gateway, providers, { dataDir, appVersion: "0.0.0-test" });
const UI_VERSION = "0.0.0-test";
const uiHeaders = { "x-ui-version": UI_VERSION };
const get = (url) => app.inject({ method: "GET", url });

// ---- 1) 列出种子规则 -------------------------------------------------------
const list = JSON.parse((await get("/api/billing/rules")).body);
assert.equal(list.rules.length, 3);
const flash = list.rules.find((r) => r.ruleId === "deepseek-v4-flash");
assert.equal(flash.currency, "CNY");
assert.deepEqual(flash.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
assert.deepEqual(flash.offpeakWindow, { startMinute: 990, endMinute: 30 });

// ---- 2) 写操作要页面版本守卫 -----------------------------------------------
const noVersion = await app.inject({
  method: "PUT",
  url: "/api/billing/rules/my-model",
  payload: { provider: "cline", model: "x", peak: { cacheHit: 1, cacheMiss: 1, output: 1 } },
});
assert.equal(noVersion.statusCode, 428, "缺 x-ui-version 的写请求必须被拒绝");

// ---- 3) 校验失败 → 400，且不落库 --------------------------------------------
const bad = await app.inject({
  method: "PUT",
  url: "/api/billing/rules/my-model",
  headers: uiHeaders,
  payload: { model: "x", peak: { cacheHit: 1, cacheMiss: 1, output: 1 } },
});
assert.equal(bad.statusCode, 400);
assert.match(JSON.parse(bad.body).error, /provider 必填/);
assert.equal(store.getBillingRule("my-model"), undefined, "校验失败不落库");

// ---- 4) 正常 upsert → 生效、可再改、可删 ------------------------------------
const ok = await app.inject({
  method: "PUT",
  url: "/api/billing/rules/my-model",
  headers: uiHeaders,
  payload: {
    provider: "cline",
    model: "my-model",
    currency: "CNY",
    usdPerUnit: 1 / 7.1,
    peak: { cacheHit: 0.1, cacheMiss: 1, output: 2 },
    offpeak: { cacheHit: 0.05, cacheMiss: 0.5, output: 1 },
    offpeakWindow: { startMinute: 990, endMinute: 30 },
    priority: 5,
    enabled: true,
  },
});
assert.equal(ok.statusCode, 200, ok.body);
assert.equal(JSON.parse(ok.body).priority, 5);
const after = JSON.parse((await get("/api/billing/rules")).body);
assert.equal(after.rules.length, 4, "新规则出现在列表里");
// 改价后立即生效（计费每次现读表）
assert.equal(gateway.listBillingRules().find((r) => r.ruleId === "my-model").peak.output, 2);
await app.inject({
  method: "PUT",
  url: "/api/billing/rules/my-model",
  headers: uiHeaders,
  payload: {
    provider: "cline",
    model: "my-model",
    peak: { cacheHit: 0.1, cacheMiss: 1, output: 3 },
    enabled: true,
  },
});
assert.equal(gateway.listBillingRules().find((r) => r.ruleId === "my-model").peak.output, 3);
const deleted = await app.inject({ method: "DELETE", url: "/api/billing/rules/my-model", headers: uiHeaders });
assert.equal(deleted.statusCode, 200);
assert.equal(
  (await app.inject({ method: "DELETE", url: "/api/billing/rules/my-model", headers: uiHeaders })).statusCode,
  404,
);

// ---- 5) 任务统计里两个口径分开返回 -----------------------------------------
// 命中规则的 run：本币 ¥10.04 / $1.4141，SDK 上报 7 分
const task = store.createTask({
  title: "billing-api",
  workspace: path.join(dataDir, "ws"),
  provider: "cline",
  model: "deepseek-v4-flash",
  projectId: DEFAULT_PROJECT_ID,
});
const usage = { inputTokens: 2_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };
store.createRun({ runId: "run-a", taskId: task.taskId, agentId: "cls-1", provider: "cline", model: "deepseek-v4-flash" });
store.updateRun("run-a", {
  status: "finished",
  usage,
  cost: {
    currency: "USD",
    estimatedCents: 141.41,
    chargedCents: 7,
    model: "deepseek-v4-flash",
    billing: {
      ruleId: "deepseek-v4-flash",
      provider: "cline",
      model: "deepseek-v4-flash",
      matchedBy: "exact",
      period: "peak",
      at: "2026-09-18T02:00:00.000Z",
      currency: "CNY",
      usdPerUnit: 1 / 7.1,
      amount: 10.04,
      usdCents: 141.41,
      prices: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      tokens: { cacheHit: 1_000_000, cacheMiss: 1_000_000, cacheWrite: 0, output: 1_000_000 },
      breakdown: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
      offpeakWindow: { startMinute: 990, endMinute: 30 },
    },
  },
});
// 没命中规则的老 run：实际成本 = SDK 上报值（两个口径同值），旧估算不参与
store.createRun({ runId: "run-b", taskId: task.taskId, agentId: "cls-1", provider: "cursor", model: "composer-1" });
store.updateRun("run-b", { status: "finished", usage, cost: { currency: "USD", chargedCents: 3, estimatedCents: 5 } });

const detail = JSON.parse((await get(`/api/tasks/${task.taskId}`)).body);
assert.equal(detail.stats.costCents, 144.41, "主口径 = 表算的 141.41 + 没规则那轮的上报值 3");
assert.equal(detail.stats.billedAmount, 10.04, "本币金额只累计命中规则的 run");
assert.equal(detail.stats.billedCurrency, "CNY");
assert.equal(detail.stats.chargedCents, 10, "SDK 上报 = 7 + 3（独立口径）");
assert.deepEqual(detail.stats.costSources, { rule: 1, reported: 1, estimate: 0 });
assert.equal(detail.runs.length, 2);

// 全是「没规则」的任务（cursor）：实际成本 = 上报值，两个口径同值
const cursorTask = store.createTask({
  title: "cursor-only",
  workspace: path.join(dataDir, "ws2"),
  provider: "cursor",
  model: "composer-1",
  projectId: DEFAULT_PROJECT_ID,
});
store.createRun({ runId: "run-d", taskId: cursorTask.taskId, agentId: "agent-1", provider: "cursor", model: "composer-1" });
store.updateRun("run-d", { status: "finished", usage, cost: { currency: "USD", chargedCents: 123, estimatedCents: 999 } });
const cursorStats = JSON.parse((await get(`/api/tasks/${cursorTask.taskId}`)).body).stats;
assert.equal(cursorStats.costCents, cursorStats.chargedCents, "没规则时两个口径同值");
assert.equal(cursorStats.costCents, 123);
assert.equal(cursorStats.billedAmount, undefined, "没有计费表明细 → 不给本币金额（前端退回美元）");
assert.deepEqual(cursorStats.costSources, { rule: 0, reported: 1, estimate: 0 });

store.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: /api/billing/rules CRUD + task stats expose both cost口径 (no rule => same value)");
