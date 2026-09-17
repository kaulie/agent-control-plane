/**
 * HTTP-level checks for the UI-version write guard (backend/src/http/ui-version.ts):
 * every frontend write must carry `x-ui-version` matching the version the project
 * currently serves, otherwise it is rejected (nothing is persisted); GETs and the
 * deployment platform's `/api/ops/*` contract are untouched.
 *
 * Usage: npm run build --workspace backend && node backend/scripts/test-ui-version-guard.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../dist/store/db.js";
import { AgentGateway } from "../dist/gateway/gateway.js";
import { registerRoutes } from "../dist/http/routes.js";
import { UI_VERSION_HEADER, UI_VERSION_MISMATCH } from "../dist/http/ui-version.js";

const SERVER_VERSION = "0.0.0-test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-ui-version-"));
const store = new Store(dataDir);
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
  appVersion: SERVER_VERSION,
});

const project = (payload, headers) =>
  app.inject({ method: "POST", url: "/api/projects", payload, headers });
const validBody = { name: "Guard", department: { departmentId: "D0001" } };

// 1) 缺 header：拒绝（428），且**没有落库**。
const missing = await project(validBody);
assert.equal(missing.statusCode, 428);
const missingBody = JSON.parse(missing.body);
assert.equal(missingBody.code, UI_VERSION_MISMATCH);
assert.equal(missingBody.clientVersion, null);
assert.equal(missingBody.serverVersion, SERVER_VERSION);
assert.equal(missingBody.mustRefresh, true);
assert.equal(store.listProjects().some((p) => p.name === "Guard"), false);

// 2) 页面版本过期（UI 停留在旧版本）：409，回显两个版本，同样不落库。
const stale = await project(validBody, { [UI_VERSION_HEADER]: "0.0.0-old" });
assert.equal(stale.statusCode, 409);
const staleBody = JSON.parse(stale.body);
assert.equal(staleBody.code, UI_VERSION_MISMATCH);
assert.equal(staleBody.clientVersion, "0.0.0-old");
assert.equal(staleBody.serverVersion, SERVER_VERSION);
assert.equal(store.listProjects().some((p) => p.name === "Guard"), false);

// 3) 版本一致：正常写入。
const ok = await project(validBody, { [UI_VERSION_HEADER]: SERVER_VERSION });
assert.equal(ok.statusCode, 201);
const created = JSON.parse(ok.body);
assert.equal(store.listProjects().some((p) => p.projectId === created.projectId), true);

// 4) 所有写方法都被覆盖（PATCH 设置页同样拦）。值保持旧版本不变。
const settingsUrl = `/api/projects/${created.projectId}/settings`;
const patchStale = await app.inject({
  method: "PATCH",
  url: settingsUrl,
  payload: { department: { departmentId: "D9999", departmentName: "越权" } },
  headers: { [UI_VERSION_HEADER]: "0.0.0-old" },
});
assert.equal(patchStale.statusCode, 409);
const after = JSON.parse((await app.inject({ method: "GET", url: settingsUrl })).body);
assert.equal(after.project.department.departmentId, "D0001");

const patchOk = await app.inject({
  method: "PATCH",
  url: settingsUrl,
  payload: { department: { departmentId: "D0002" } },
  headers: { [UI_VERSION_HEADER]: SERVER_VERSION },
});
assert.equal(patchOk.statusCode, 200);

// 5) 只读请求不受影响（不要求 header）。
const list = await app.inject({ method: "GET", url: "/api/projects" });
assert.equal(list.statusCode, 200);
assert.equal(JSON.parse(list.body).length >= 1, true);

// 6) 部署平台的重启契约（/api/ops/*，非浏览器发起）照样放行。
const notify = await app.inject({
  method: "POST",
  url: "/api/ops/restart-notify",
  payload: {
    serviceId: "web-cursor",
    requestId: "req-1",
    deployment: "deployment-test",
    message: "graceful restart",
  },
});
assert.equal(notify.statusCode, 200);
assert.equal(JSON.parse(notify.body).ok, true);

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(
  "PASS: frontend writes require a matching x-ui-version (missing → 428, stale → 409, ops/* exempt)",
);
