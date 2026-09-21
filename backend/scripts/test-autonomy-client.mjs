/**
 * autonomy 客户端（`backend/src/autonomy.ts`）检查。
 *
 * 守两件事：
 * 1. **读**是 best-effort：不可达 / 超时 → `available:false` + 原因，**从不抛异常**（页面要显示
 *    「autonomy 不可达」而不是 500）；成功结果按 TTL 缓存（失败缓存更短）。
 * 2. **写**（createTask）绝不静默降级：autonomy 明确拒绝 → `ok:false` + 它的原文 + `httpStatus`；
 *    连不上 / 超时 → `ok:false` 且**没有** httpStatus（由路由转 503），不假装成功。
 *
 * 用法：npx tsx backend/scripts/test-autonomy-client.mjs   （或：npm test）
 */
import assert from "node:assert/strict";
import {
  AutonomyClient,
  autonomyTasksUrl,
  normalizeCreateResult,
  normalizeTaskList,
  readAutonomyError,
} from "../src/autonomy.ts";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });
/** 假 fetch：按 URL 尾巴路由，记录每次调用。 */
function makeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    // 按 **path** 匹配（忽略 query），否则带 `?project_id=…` 的调用匹配不到。
    const path = url.split("?")[0];
    const key = Object.keys(handlers).find((k) => path.endsWith(k));
    if (!key) throw new Error(`no handler for ${url}`);
    const h = handlers[key];
    return typeof h === "function" ? h(url, init) : h;
  };
  return { impl, calls };
}

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
};

const BASE = "http://127.0.0.1:4300";

await check("status(): meta + health 合并，成功结果按 TTL 缓存", async () => {
  const { impl, calls } = makeFetch({
    "/api/meta": ok({ service: "autonomy", version: "ff9899c0", turns: 3 }),
    "/health": ok({ status: "ok", llm_backend: "cline", llm_model: "deepseek-v4-flash", turns: 3 }),
  });
  let now = 1_000_000;
  const client = new AutonomyClient({ baseUrl: BASE + "/", fetchImpl: impl, now: () => now });
  const first = await client.status();
  assert.equal(first.available, true);
  assert.equal(first.url, BASE);
  assert.equal(first.version, "ff9899c0");
  assert.equal(first.llmBackend, "cline");
  assert.equal(first.llmModel, "deepseek-v4-flash");
  assert.equal(first.turns, 3);
  const used = calls.length;
  assert.equal(used, 2, "meta + health 各一次");
  now += 1000;
  await client.status();
  assert.equal(calls.length, used, "30s 内第二次读走缓存");
  await client.status({ refresh: true });
  assert.equal(calls.length, used + 2, "refresh 绕过缓存");
});

await check("status(): 不可达 → available:false（不抛），失败缓存 5s", async () => {
  const boom = () => {
    const err = new Error("connect ECONNREFUSED");
    err.name = "TypeError";
    throw err;
  };
  const { impl, calls } = makeFetch({ "/api/meta": boom, "/health": boom });
  let now = 2_000_000;
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl, now: () => now });
  const s = await client.status();
  assert.equal(s.available, false);
  assert.match(s.error, /ECONNREFUSED/);
  const used = calls.length;
  now += 4000;
  await client.status();
  assert.equal(calls.length, used, "失败结果 5s 内也缓存（避免每次都打）");
  now += 2000;
  await client.status();
  assert.ok(calls.length > used, "超过 5s 重新探测");
});

await check("status(): 超时文案带 timeoutMs", async () => {
  const boom = () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  const { impl } = makeFetch({ "/api/meta": boom, "/health": boom });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl, timeoutMs: 2500 });
  const s = await client.status();
  assert.equal(s.available, false);
  assert.match(s.error, />2500ms/);
});

await check("createTask(): 202 → 接受信息（task_id / agent_id / queued）+ 正确的 body", async () => {
  const { impl, calls } = makeFetch({
    "/api/tasks": ok({ task_id: "task-abc", agent_id: 10000, status: "pending", message_id: 1000001, queued: 0 }),
  });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  const r = await client.createTask({ description: "  写个 demo  ", projectId: "project-59c41b54" });
  assert.equal(r.ok, true);
  assert.equal(r.taskId, "task-abc");
  assert.equal(r.agentId, 10000);
  assert.equal(r.status, "pending");
  assert.equal(r.queued, 0);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.description, "写个 demo", "描述 trim");
  assert.deepEqual(sent.context_ref, { project: "project-59c41b54" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, `${BASE}/api/tasks`);
});

await check("createTask(): 不带 projectId 就不发 context_ref", async () => {
  const { impl, calls } = makeFetch({ "/api/tasks": ok({ task_id: "task-abc" }) });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  await client.createTask({ description: "x" });
  assert.equal("context_ref" in JSON.parse(calls[0].init.body), false);
});

await check("createTask(): autonomy 拒绝（4xx）→ 原文 + httpStatus", async () => {
  const { impl } = makeFetch({
    "/api/tasks": fail(400, { error: "unknown project project-nope" }),
  });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  const r = await client.createTask({ description: "x", projectId: "project-nope" });
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 400);
  assert.match(r.error, /unknown project/);
});

await check("createTask(): 连不上 → ok:false 且没有 httpStatus（交给路由转 503）", async () => {
  const { impl } = makeFetch({ "/api/tasks": () => { throw new Error("fetch failed"); } });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  const r = await client.createTask({ description: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, undefined);
  assert.match(r.error, /fetch failed/);
});

await check("createTask(): 空描述本地就拒（不打 autonomy）", async () => {
  const { impl, calls } = makeFetch({ "/api/tasks": ok({ task_id: "t" }) });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  const r = await client.createTask({ description: "   " });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

await check("listTasks(): 归一化 + project 过滤 + 不可达降级", async () => {
  const rows = {
    tasks: [
      { id: "task-1", description: "d", status: "running", turns: 2, last_at: "2026-09-21T01:00:00Z", project_id: "project-x", agent_id: 10000, updated_at: "2026-09-21T01:00:01Z" },
      { description: "no id → 丢掉" },
      "garbage",
    ],
  };
  const { impl, calls } = makeFetch({ "/api/tasks": ok(rows) });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  const withFilter = await client.listTasks({ projectId: "project-x" });
  assert.equal(withFilter.available, true);
  assert.equal(withFilter.tasks.length, 1);
  assert.deepEqual(withFilter.tasks[0], {
    id: "task-1", description: "d", status: "running", turns: 2,
    lastAt: "2026-09-21T01:00:00Z", projectId: "project-x", agentId: 10000,
    updatedAt: "2026-09-21T01:00:01Z",
  });
  assert.match(calls[0].url, /\?project_id=project-x$/);
  const all = await client.listTasks();
  assert.equal(calls[1].url.endsWith("/api/tasks"), true, "不带过滤就不带 query");
  assert.equal(all.tasks.length, 1);

  const down = new AutonomyClient({ baseUrl: BASE, fetchImpl: makeFetch({ "/api/tasks": fail(500, { error: "store not ready" }) }).impl });
  const r = await down.listTasks();
  assert.equal(r.available, false);
  assert.equal(r.tasks.length, 0);
  assert.match(r.error, /HTTP 500/);
});

await check("getTask(): 200 → 详情；404 → status 404（供路由透传）；不可达 → status 0", async () => {
  const { impl } = makeFetch({ "/api/tasks/task-1": ok({ task_id: "task-1", status: "blocked", plans: [] }) });
  const client = new AutonomyClient({ baseUrl: BASE, fetchImpl: impl });
  const found = await client.getTask("task-1");
  assert.equal(found.available, true);
  assert.equal(found.status, 200);
  assert.equal(found.task.status, "blocked");

  const missing = new AutonomyClient({ baseUrl: BASE, fetchImpl: makeFetch({ "/api/tasks/task-x": fail(404, { error: "task not found" }) }).impl });
  const m = await missing.getTask("task-x");
  assert.equal(m.available, false);
  assert.equal(m.status, 404);
  assert.equal(m.error, "task not found");

  const down = new AutonomyClient({ baseUrl: BASE, fetchImpl: makeFetch({ "/api/tasks/task-y": () => { throw new Error("ECONNREFUSED"); } }).impl });
  const d = await down.getTask("task-y");
  assert.equal(d.available, false);
  assert.equal(d.status, 0);

  const bad = new AutonomyClient({ baseUrl: BASE, fetchImpl: makeFetch({}).impl });
  const b = await bad.getTask("  ");
  assert.equal(b.status, 400, "空 id 不打服务");
});

await check("纯函数：url / 归一化 / 错误体", () => {
  assert.equal(autonomyTasksUrl("http://x:4300/", "p 1"), "http://x:4300/api/tasks?project_id=p%201");
  assert.equal(autonomyTasksUrl("http://x:4300"), "http://x:4300/api/tasks");
  assert.deepEqual(normalizeTaskList({ tasks: [{ id: "a" }] })[0].turns, 0);
  assert.deepEqual(normalizeTaskList({ nope: 1 }), []);
  assert.equal(readAutonomyError({ error: " boom " }, "fallback"), "boom");
  assert.equal(readAutonomyError({}, "fallback"), "fallback");
  assert.equal(normalizeCreateResult({ status: "pending" }).ok, false, "没有 task_id 不算成功");
  assert.equal(normalizeCreateResult(null).ok, false);
});

console.log(failed ? `\n${failed} check(s) failed` : "\ntest-autonomy-client: ok");
process.exit(failed ? 1 : 0);
