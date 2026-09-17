/**
 * HTTP-level checks for project creation: `POST /api/projects` requires a
 * department and stores it with the project (settings_json), name/gitRepoUrl
 * still behave as before.
 *
 * Usage: npm run build --workspace backend && node backend/scripts/test-project-api.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { registerRoutes } from "../dist/http/routes.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-project-api-"));
const store = new Store(dataDir);
/** Only the bits registerRoutes / AgentGateway touch for these routes. */
const providers = {
  has: () => false,
  get default() {
    return {
      name: "cursor",
      verifyAuth: async () => ({ ok: true, detail: "" }),
      listModels: async () => [],
    };
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
await registerRoutes(app, gateway, providers, {
  dataDir,
  appVersion: "0.0.0-test",
  // organization 服务不在测试里跑；部门列表不可用不影响创建（值来自前端选择）。
});

const create = (payload) =>
  app.inject({ method: "POST", url: "/api/projects", payload });
const settingsOf = async (projectId) =>
  JSON.parse(
    (await app.inject({ method: "GET", url: `/api/projects/${projectId}/settings` }))
      .body,
  );

// 1) 没有部门 => 400，不落库。
const missing = await create({ name: "No Department" });
assert.equal(missing.statusCode, 400);
assert.equal(JSON.parse(missing.body).error, "department is required");
assert.equal(store.listProjects().some((p) => p.name === "No Department"), false);

// 2) 部门字段为空串 / 全空白 => 同样 400。
for (const department of [
  {},
  { departmentId: "", departmentName: "" },
  { departmentId: "   ", departmentName: "  " },
]) {
  const res = await create({ name: "Blank Department", department });
  assert.equal(res.statusCode, 400, `blank department ${JSON.stringify(department)}`);
  assert.equal(JSON.parse(res.body).error, "department is required");
}

// 3) 带部门 => 201，且项目设置里能读到（trim 过）。
const created = await create({
  name: "  Smoke Project  ",
  gitRepoUrl: " https://github.com/kaulie/agent-control-plane ",
  department: { departmentId: " D0001 ", departmentName: " SRE部门 " },
});
assert.equal(created.statusCode, 201);
const project = JSON.parse(created.body);
assert.equal(project.name, "Smoke Project");
assert.equal(project.gitRepoUrl, "https://github.com/kaulie/agent-control-plane");
const view = await settingsOf(project.projectId);
assert.deepEqual(view.project.department, {
  departmentId: "D0001",
  departmentName: "SRE部门",
});
assert.deepEqual(view.effective.department, {
  departmentId: "D0001",
  departmentName: "SRE部门",
});

// 4) 只有 id 也算选了部门（名称快照缺失时保留 id）。
const idOnly = await create({ name: "Id Only", department: { departmentId: "D0002" } });
assert.equal(idOnly.statusCode, 201);
assert.deepEqual(
  (await settingsOf(JSON.parse(idOnly.body).projectId)).project.department,
  { departmentId: "D0002" },
);

// 5) 名字缺失时优先报名字（部门必填的另一条路径各自独立）。
const noName = await create({ department: { departmentId: "D0001" } });
assert.equal(noName.statusCode, 400);
assert.equal(JSON.parse(noName.body).error, "name is required");

// 6) 未配置 Git 地址时不写 gitRepoUrl 字段。
const noGit = await create({ name: "No Git", department: { departmentId: "D0001" } });
assert.equal(noGit.statusCode, 201);
assert.equal(JSON.parse(noGit.body).gitRepoUrl, undefined);

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: POST /api/projects requires + stores department");
