/**
 * HTTP-level checks for project creation: `POST /api/projects` requires a
 * department and stores it with the project (settings_json), name/gitRepoUrl
 * still behave as before. Also covers「按 task_id 查详情」：`GET /api/tasks/:taskId`
 * 必须带 project（名字 / gitRepoUrl / 部门），项目被删掉时也不能 500；
 * 以及单项项目接口 `GET /api/projects/:projectId`（形状 = 列表里那一项，未知 → 404）。
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

// 10) 按 task_id 查详情：project（名字 / gitRepoUrl / 部门）一并返回。
const task = store.createTask({
  taskId: "task-detail-1",
  title: "详情任务",
  workspace: path.join(dataDir, "ws", "task-detail-1"),
  provider: "cursor",
  projectId: project.projectId,
});
const detail = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/tasks/${task.taskId}` })).body,
);
assert.equal(detail.task.taskId, task.taskId);
assert.equal(detail.task.projectId, project.projectId);
assert.equal(detail.project.projectId, project.projectId, "详情要带 project");
assert.equal(detail.project.name, "Smoke Project");
assert.equal(detail.project.gitRepoUrl, "https://github.com/kaulie/agent-control-plane");
assert.deepEqual(
  detail.project.department,
  { departmentId: "D0002", departmentName: "工程效能部门" },
  "详情里的部门跟着项目设置走",
);

// 11) 没有部门的项目（老数据）→ project 仍在，只是不带 department 字段。
const legacyTask = store.createTask({
  taskId: "task-detail-legacy",
  title: "老项目任务",
  workspace: path.join(dataDir, "ws", "task-detail-legacy"),
  provider: "cursor",
  projectId: legacyId,
});
const legacyDetail = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/tasks/${legacyTask.taskId}` })).body,
);
assert.equal(legacyDetail.project.name, "Legacy");
assert.equal(legacyDetail.project.department, undefined);

// 12) 项目已被删掉的老数据 → 详情照常返回 task，只是没有 project（不能 500）。
store.db.prepare(`DELETE FROM projects WHERE project_id = ?`).run(legacyId);
const orphanDetail = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/tasks/${legacyTask.taskId}` })).body,
);
assert.equal(orphanDetail.task.taskId, legacyTask.taskId);
assert.equal(orphanDetail.project, undefined);

// 13) 单项项目接口：形状和列表里的那一项完全一致。
const single = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/projects/${project.projectId}` })).body,
);
assert.equal(single.projectId, project.projectId);
assert.equal(single.name, "Smoke Project");
assert.equal(single.gitRepoUrl, "https://github.com/kaulie/agent-control-plane");
assert.deepEqual(single.department, {
  departmentId: "D0002",
  departmentName: "工程效能部门",
});
assert.deepEqual(
  single,
  await listedProject(project.projectId),
  "单项接口不能和列表是两套口径",
);

// 没有部门的老项目 → 单独查也还是「没有 department 字段」（两个接口一套口径）。
const plainId = "project-no-dept";
store.db
  .prepare(
    `INSERT INTO projects (project_id, name, workspace_root, git_repo_url, settings_json, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
  )
  .run(plainId, "No Dept", new Date().toISOString(), new Date().toISOString());
const plainSingle = JSON.parse(
  (await app.inject({ method: "GET", url: `/api/projects/${plainId}` })).body,
);
assert.equal(plainSingle.projectId, plainId);
assert.equal(plainSingle.department, undefined);

// 已被删掉的项目（section 12 删的）→ 404，不是空对象。
const deletedProject = await app.inject({
  method: "GET",
  url: `/api/projects/${legacyId}`,
});
assert.equal(deletedProject.statusCode, 404);

// 不知道的项目 → 404（不是空对象 / 500）。
const unknown = await app.inject({
  method: "GET",
  url: "/api/projects/project-does-not-exist",
});
assert.equal(unknown.statusCode, 404);
assert.equal(JSON.parse(unknown.body).error, "project not found");

// 参数路由不能把 /settings 子路由吃掉。
const settingsStillWorks = await app.inject({
  method: "GET",
  url: `/api/projects/${project.projectId}/settings`,
});
assert.equal(settingsStillWorks.statusCode, 200);

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(
  "PASS: POST /api/projects requires + stores department, list carries it, task detail carries project+department, single project GET (404 for unknown)",
);
