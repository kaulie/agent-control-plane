/**
 * Provider + 账号池：
 * 1. CRUD + key 掩码（列表不回完整 key）；
 * 2. 同一 (provider, vendor) 只有一个默认；
 * 3. Cline 可同时挂多把 deepseek / minimax；
 * 4. 创建任务用账号的 agentRootWorkspace/{agentId}；
 * 5. run 把账号的 apiKey / vendor 传给 provider。
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
  duplicateAgentRootMessage,
  findAccountUsingRoot,
  maskApiKey,
  normalizeAgentRootWorkspace,
} from "../src/accounts.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-accounts-"));
const rootA = path.join(dir, "ws-a");
const rootB = path.join(dir, "ws-b");
const rootC = path.join(dir, "ws-c");
const rootD = path.join(dir, "ws-d");
const store = new Store(dir);
const project = store.createProject("account-pool");

const calls = [];
const cursorProvider = {
  name: "cursor",
  async verifyAuth() {
    return { ok: true, detail: "authenticated as cursor-a@test.com" };
  },
  async listModels() {
    return [{ id: "grok-4.6", displayName: "Grok 4.6" }];
  },
  async resolveModel() {
    return "grok-4.6";
  },
  async run(input) {
    calls.push({ provider: "cursor", input });
    return {
      status: "finished",
      result: "ok",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
      agentId: "agent-sdk-1",
    };
  },
  async cancel() {
    return true;
  },
};
const clineProvider = {
  name: "cline",
  async verifyAuth(opts) {
    return {
      ok: true,
      detail: `provider "${opts?.vendor ?? "deepseek"}" configured (key present)`,
    };
  },
  async listModels() {
    return [];
  },
  async resolveModel() {
    return undefined;
  },
  async run(input) {
    calls.push({ provider: "cline", input });
    return {
      status: "finished",
      result: "ok",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
      agentId: input.preallocatedAgentId || "cls-1",
    };
  },
  async cancel() {
    return true;
  },
};

const registry = new ProviderRegistry("cursor", [cursorProvider, clineProvider]);
const gateway = new AgentGateway(
  store,
  registry,
  { agentWorkspaceRoot: path.join(dir, "ws-fallback"), dataDir: dir },
  () => {},
);
const app = Fastify({ logger: false });
await registerRoutes(app, gateway, registry, {
  dataDir: dir,
  appVersion: "0.0.0-test",
});
const hdr = { "x-ui-version": "0.0.0-test" };

assert.equal(maskApiKey("cur_live_abcdefghijklmn"), "cur_…klmn");
assert.equal(
  normalizeAgentRootWorkspace(`${rootA}/`),
  normalizeAgentRootWorkspace(rootA),
  "trailing slash is the same root",
);
assert.equal(
  findAccountUsingRoot(
    [{ accountId: "a1", agentRootWorkspace: rootA }],
    `${rootA}/`,
  )?.accountId,
  "a1",
);
assert.equal(
  findAccountUsingRoot(
    [{ accountId: "a1", agentRootWorkspace: rootA }],
    rootA,
    "a1",
  ),
  undefined,
  "editing self is not a conflict",
);

// 1) 创建 Cursor + 两把 DeepSeek + 一把 MiniMax
const cursorAcc = await app.inject({
  method: "POST",
  url: "/api/accounts",
  headers: hdr,
  payload: {
    provider: "cursor",
    label: "Cursor 主号",
    apiKey: "cur_live_primary_secret_key",
    agentRootWorkspace: rootA,
    isDefault: true,
  },
});
assert.equal(cursorAcc.statusCode, 201, cursorAcc.body);
const cursorBody = JSON.parse(cursorAcc.body);
assert.equal(cursorBody.vendor, "cursor");
assert.equal(cursorBody.apiKeyMasked, "cur_…_key");
assert.ok(!JSON.stringify(cursorBody).includes("primary_secret"));

const ds1 = await app.inject({
  method: "POST",
  url: "/api/accounts",
  headers: hdr,
  payload: {
    provider: "cline",
    vendor: "deepseek",
    label: "DeepSeek A",
    apiKey: "sk-deepseek-aaa",
    agentRootWorkspace: rootB,
    isDefault: true,
  },
});
const ds2 = await app.inject({
  method: "POST",
  url: "/api/accounts",
  headers: hdr,
  payload: {
    provider: "cline",
    vendor: "deepseek",
    label: "DeepSeek B",
    apiKey: "sk-deepseek-bbb",
    agentRootWorkspace: rootC,
  },
});
const mm = await app.inject({
  method: "POST",
  url: "/api/accounts",
  headers: hdr,
  payload: {
    provider: "cline",
    vendor: "minimax",
    label: "MiniMax 夜班",
    apiKey: "mm-key-night",
    agentRootWorkspace: rootD,
    isDefault: true,
  },
});
assert.equal(ds1.statusCode, 201, ds1.body);
assert.equal(ds2.statusCode, 201, ds2.body);
assert.equal(mm.statusCode, 201, mm.body);

const listed = JSON.parse(
  (await app.inject({ method: "GET", url: "/api/accounts" })).body,
);
assert.equal(listed.accounts.length, 4);
assert.ok(listed.vendors.cline.includes("deepseek"));
assert.equal(
  listed.accounts.filter((a) => a.provider === "cline" && a.vendor === "deepseek").length,
  2,
  "同一 vendor 可以挂多把 key",
);
assert.ok(!JSON.stringify(listed).includes("sk-deepseek-aaa"));

const dupCreate = await app.inject({
  method: "POST",
  url: "/api/accounts",
  headers: hdr,
  payload: {
    provider: "cursor",
    label: "撞根目录",
    apiKey: "cur_live_other_key",
    agentRootWorkspace: `${rootA}/`,
  },
});
assert.equal(dupCreate.statusCode, 400, dupCreate.body);
assert.match(
  JSON.parse(dupCreate.body).error,
  /不同账号必须使用不同的工作根目录/,
);
assert.match(
  JSON.parse(dupCreate.body).error,
  /Cursor 主号/,
);

const keepOwn = await app.inject({
  method: "PATCH",
  url: `/api/accounts/${cursorBody.accountId}`,
  headers: hdr,
  payload: {
    provider: "cursor",
    label: "Cursor 主号",
    agentRootWorkspace: `${rootA}/`,
  },
});
assert.equal(keepOwn.statusCode, 200, keepOwn.body);

const stealRoot = await app.inject({
  method: "PATCH",
  url: `/api/accounts/${JSON.parse(ds1.body).accountId}`,
  headers: hdr,
  payload: {
    provider: "cline",
    vendor: "deepseek",
    label: "DeepSeek A",
    agentRootWorkspace: rootA,
  },
});
assert.equal(stealRoot.statusCode, 400, stealRoot.body);
assert.equal(
  JSON.parse(stealRoot.body).error,
  duplicateAgentRootMessage("Cursor 主号", rootA),
);

// 2) 创建任务：workspace = 该账号 root / agentId
const created = await app.inject({
  method: "POST",
  url: "/api/tasks",
  headers: hdr,
  payload: {
    title: "用 Cursor 主号",
    description: "账号池工作区",
    projectId: project.projectId,
    accountId: cursorBody.accountId,
  },
});
assert.equal(created.statusCode, 201, created.body);
const task = JSON.parse(created.body);
assert.equal(task.accountId, cursorBody.accountId);
assert.equal(task.provider, "cursor");
assert.equal(path.dirname(task.workspace), rootA);
assert.ok(fs.existsSync(task.workspace));

const clineTaskRes = await app.inject({
  method: "POST",
  url: "/api/tasks",
  headers: hdr,
  payload: {
    title: "用 MiniMax",
    description: "cline vendor 账号",
    projectId: project.projectId,
    accountId: JSON.parse(mm.body).accountId,
  },
});
assert.equal(clineTaskRes.statusCode, 201, clineTaskRes.body);
const clineTask = JSON.parse(clineTaskRes.body);
assert.equal(clineTask.provider, "cline");
assert.equal(path.dirname(clineTask.workspace), rootD);

async function waitForRun(taskId) {
  for (let i = 0; i < 300; i += 1) {
    const run = store.listRuns(taskId)[0];
    if (run && run.status !== "running" && run.status !== "queued") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run 没结束");
}

await waitForRun(task.taskId);
await waitForRun(clineTask.taskId);
const cursorCall = calls.find((c) => c.input.taskId === task.taskId);
const clineCall = calls.find((c) => c.input.taskId === clineTask.taskId);
assert.equal(cursorCall.input.apiKey, "cur_live_primary_secret_key");
assert.equal(clineCall.input.apiKey, "mm-key-night");
assert.equal(clineCall.input.vendor, "minimax");

// 3) 有进行中任务时不能删（这个 task 已 finished，再造一个 active 不跑）
store.createTask({
  title: "占着号",
  workspace: path.join(rootA, "hold"),
  provider: "cursor",
  projectId: project.projectId,
  accountId: cursorBody.accountId,
  description: "hold",
});
const delBusy = await app.inject({
  method: "DELETE",
  url: `/api/accounts/${cursorBody.accountId}`,
  headers: hdr,
});
assert.equal(delBusy.statusCode, 400, delBusy.body);

const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-accounts-seed-"));
const seedStore = new Store(seedDir);
const seeded = seedStore.seedLegacyAccountsIfEmpty({
  workspaceRoot: path.join(seedDir, "ws"),
  cursorApiKey: "cur_seed",
  clineApiKey: "sk-seed",
  clineVendor: "deepseek",
});
assert.equal(seeded.length, 2);
assert.notEqual(
  seeded[0].agentRootWorkspace,
  seeded[1].agentRootWorkspace,
  "seeded cursor/cline must not share a root",
);
seedStore.close();

console.log("PASS: account pool");
process.exit(0);
