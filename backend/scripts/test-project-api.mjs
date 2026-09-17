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

/** 前端每个写请求都带的“页面版本”（见 backend/src/http/ui-version.ts）。 */
const UI_VERSION = "0.0.0-test";
const uiHeaders = { "x-ui-version": UI_VERSION };

const create = (payload) =>
  app.inject({
    method: "POST",
    url: "/api/projects",
    payload,
    headers: uiHeaders,
  });
const settingsOf = async (projectId) =>
  JSON.parse(
    (await app.inject({ method: "GET", url: `/api/projects/${projectId}/settings` }))
      .body,
  );
/** 左栏（项目列表）就是读这里：项目必须自带部门。 */
const listedProject = async (projectId) => {
  const list = JSON.parse((await app.inject({ method: "GET", url: "/api/projects" })).body);
  return list.find((p) => p.projectId === projectId);
};

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

// 7) 左栏用的项目列表（GET /api/projects）自带部门，创建响应里也有。
assert.deepEqual(project.department, {
  departmentId: "D0001",
  departmentName: "SRE部门",
});
assert.deepEqual((await listedProject(project.projectId)).department, {
  departmentId: "D0001",
  departmentName: "SRE部门",
});

// 8) 在项目设置里改了部门 → 列表立刻跟着变（左栏显示的就是它）。
await app.inject({
  method: "PATCH",
  url: `/api/projects/${project.projectId}/settings`,
  payload: { department: { departmentId: "D0002", departmentName: "工程效能部门" } },
  headers: uiHeaders,
});
assert.deepEqual((await listedProject(project.projectId)).department, {
  departmentId: "D0002",
  departmentName: "工程效能部门",
});

// 9) 老项目（settings_json 为 NULL）在列表里就是"没有 department 字段"。
const legacyId = "project-legacy";
store.db
  .prepare(
    `INSERT INTO projects (project_id, name, workspace_root, git_repo_url, settings_json, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
  )
  .run(legacyId, "Legacy", new Date().toISOString(), new Date().toISOString());
const legacy = await listedProject(legacyId);
assert.equal(legacy.department, undefined);
assert.equal(legacy.name, "Legacy");

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: POST /api/projects requires + stores department, list carries it");
