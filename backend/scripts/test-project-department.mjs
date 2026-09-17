/**
 * Store-level checks: a project created with a department keeps it (the pick is
 * stored in the project's `settings_json`, so it must land with the same insert).
 *
 * Usage: npm run build --workspace backend && node backend/scripts/test-project-department.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../dist/store/db.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-project-department-"));
const store = new Store(dataDir);

// 1) 新建项目时同时设置部门：id/name 都做 trim 后落库。
const withDepartment = store.createProject("Dept Project", {
  gitRepoUrl: "  https://github.com/kaulie/agent-control-plane  ",
  department: { departmentId: " D0001 ", departmentName: " SRE部门 " },
});
assert.equal(withDepartment.gitRepoUrl, "https://github.com/kaulie/agent-control-plane");
assert.deepEqual(store.getProjectSettings(withDepartment.projectId)?.department, {
  departmentId: "D0001",
  departmentName: "SRE部门",
});

// 2) 不带部门 => settings 里没有 department 字段（而不是空对象）。
const plain = store.createProject("Plain Project");
assert.equal(store.getProjectSettings(plain.projectId)?.department, undefined);

// 3) 空字符串 / 只有空白 => 视为未设置，不会写入空部门。
const empty = store.createProject("Empty Department", {
  department: { departmentId: "   ", departmentName: "" },
});
assert.equal(store.getProjectSettings(empty.projectId)?.department, undefined);

// 4) 只给 id（名称快照缺失）也保留，避免丢掉已选部门。
const idOnly = store.createProject("Id Only", {
  department: { departmentId: "D0002" },
});
assert.deepEqual(store.getProjectSettings(idOnly.projectId)?.department, {
  departmentId: "D0002",
});

// 5) 部门与其它项目设置共存（新建时写的这条 record 后续仍可被 PATCH 合并）。
store.updateProjectSettings(withDepartment.projectId, {
  runtime: { defaultProvider: "cursor" },
});
const merged = store.getProjectSettings(withDepartment.projectId);
assert.equal(merged?.runtime?.defaultProvider, "cursor");
assert.equal(merged?.department?.departmentId, "D0001");

// 6) 老项目（settings_json 为 NULL）读出来还是 {}，不受影响。
const legacy = store.createProject("Legacy");
store.db
  .prepare("UPDATE projects SET settings_json = NULL WHERE project_id = ?")
  .run(legacy.projectId);
assert.deepEqual(store.getProjectSettings(legacy.projectId), {});

fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: project department on create");
