/**
 * 对外契约（`api/openapi.json`）的守护测试：
 *
 * 1. **双向一致**：`gen-openapi.mjs --check` 必须绿 —— 路由表里有、契约里没有
 *    （且没进 OPENAPI_EXCLUDE 说明原因）会失败；契约里写了不存在的接口也会失败；
 *    产物没同步提交（改了接口忘了 `npm run openapi:gen`）同样失败；
 * 2. **产物形状**：OpenAPI 3.x + info + tags 目录 + 每个操作都有 summary / tags /
 *    operationId；路径参数用 `{name}`（不是 Fastify 的 `:name`）；
 * 3. **route-meta ↔ 产物**一一对应（没有孤儿条目）；
 * 4. 创建类接口的成功响应是 201（别的默认 200）。
 *
 * Usage: npx tsx backend/scripts/test-openapi-contract.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPENAPI_INFO,
  OPENAPI_ROUTE_META,
  OPENAPI_TAGS,
} from "../src/http/route-meta.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const specPath = path.join(repoRoot, "api", "openapi.json");

// ---- 1) 契约与路由双向一致（含「产物有没有忘提交」）----
const check = spawnSync(
  "npx",
  ["tsx", path.join("backend", "scripts", "gen-openapi.mjs"), "--check"],
  { cwd: repoRoot, encoding: "utf8" },
);
assert.equal(
  check.status,
  0,
  `openapi:check 必须通过（路由 ↔ 契约 ↔ 提交的产物）：\n${check.stdout}${check.stderr}`,
);

// ---- 2) 产物形状 ----
const doc = JSON.parse(fs.readFileSync(specPath, "utf8"));
assert.match(doc.openapi, /^3\./, "必须是 OpenAPI 3.x（服务中心按 3.x 提取端点）");
assert.equal(doc.info.title, OPENAPI_INFO.title);
assert.ok(doc.info.description?.length > 0, "info.description 不该为空");
assert.deepEqual(
  doc.tags.map((t) => t.name),
  OPENAPI_TAGS.map((t) => t.name),
  "tags 目录要与 route-meta 一致",
);

const knownTags = new Set(OPENAPI_TAGS.map((t) => t.name));
const operations = [];
for (const [p, item] of Object.entries(doc.paths)) {
  assert.ok(p.startsWith("/"), `路径必须以 / 开头：${p}`);
  assert.ok(!p.includes(":"), `路径参数要用 {name}，不能留 Fastify 的 :name：${p}`);
  for (const [method, op] of Object.entries(item)) {
    operations.push({ key: `${method.toUpperCase()} ${p}`, method, path: p, op });
    assert.ok(op.summary?.trim(), `${method.toUpperCase()} ${p} 缺少 summary`);
    assert.ok(op.operationId?.trim(), `${method.toUpperCase()} ${p} 缺少 operationId`);
    assert.ok(op.tags?.length, `${method.toUpperCase()} ${p} 缺少 tags`);
    for (const tag of op.tags) {
      assert.ok(knownTags.has(tag), `${method.toUpperCase()} ${p} 用了未知 tag ${tag}`);
    }
    assert.ok(op.responses && Object.keys(op.responses).length, "缺少 responses");
  }
}
assert.ok(operations.length >= 30, `端点数看起来太少：${operations.length}`);

// 路径参数与真实路径一致（抽查：任务详情/附件这类多参数路由）
assert.ok(doc.paths["/api/tasks/{taskId}"], "缺少 /api/tasks/{taskId}");
assert.ok(
  doc.paths["/api/tasks/{taskId}/attachments/{attachmentId}"],
  "多参数路径也要正确转写",
);

// ---- 3) route-meta ↔ 产物 一一对应 ----
const specKeys = new Set(operations.map((o) => o.key));
for (const key of Object.keys(OPENAPI_ROUTE_META)) {
  assert.ok(specKeys.has(key), `route-meta 里有产物没有的条目：${key}`);
}
for (const key of specKeys) {
  assert.ok(OPENAPI_ROUTE_META[key], `产物里有 route-meta 没有的条目：${key}`);
}

// ---- 4) 创建类接口是 201 ----
for (const key of ["POST /api/tasks", "POST /api/projects"]) {
  const op = operations.find((o) => o.key === key)?.op;
  assert.ok(op, `缺少 ${key}`);
  assert.ok(Object.keys(op.responses).includes("201"), `${key} 应该是 201`);
}
// `POST /api/tasks` 额外文档化了「执行交给 autonomy」的两种失败（400 它明确拒绝 / 503 不可达）——
// 201 之外只允许这两个，多一个就说明契约漂了。
{
  const op = operations.find((o) => o.key === "POST /api/tasks").op;
  assert.deepEqual(
    Object.keys(op.responses).sort(),
    ["201", "400", "503"],
    "POST /api/tasks 的响应集合",
  );
}

console.log(
  `✅ openapi 契约 OK（${operations.length} 个端点 / ${Object.keys(doc.paths).length} 条路径，双向一致）`,
);
