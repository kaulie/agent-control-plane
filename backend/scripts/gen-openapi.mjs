/**
 * 生成对外 API 契约 `api/openapi.json`。
 *
 * 对等物：Go 服务的 `swag init`（代码注解 → swagger.json）。本服务的做法：
 *
 *   真实路由表（src/http/routes.ts） + route-meta.ts（summary/tags）
 *        └── gen-openapi.mjs ──▶ api/openapi.json ──▶ client/register.sh ──▶ 服务中心
 *
 * 用法（在仓库根目录）：
 *   npm run openapi:gen     # 生成 / 更新 api/openapi.json
 *   npm run openapi:check   # CI：契约与路由是不是双向对齐 + 有没有忘提交生成结果
 *   npm run openapi:list    # 只列出真实路由（排查用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { registerRoutes } from "../src/http/routes.ts";
import {
  OPENAPI_EXCLUDE,
  OPENAPI_INFO,
  OPENAPI_ROUTE_META,
  OPENAPI_TAGS,
} from "../src/http/route-meta.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outFile = path.join(repoRoot, "api", "openapi.json");
const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

const args = new Set(process.argv.slice(2));
const METHODS = ["get", "post", "patch", "put", "delete"];

/** Fastify 的 `:param` → OpenAPI 的 `{param}`（契约里两边必须写成后一种）。 */
function toOpenApiPath(url) {
  if (url.includes("*")) {
    throw new Error(`路径含通配符，无法写进契约：${url}`);
  }
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * 收集**真实注册**的路由：把 registerRoutes 挂到一个空 Fastify 上（handler 里的
 * gateway/providers 只在请求时才碰，所以注册阶段用 stub 就够了）。
 */
async function collectRoutes() {
  const app = Fastify({ logger: false });
  const seen = [];
  for (const method of METHODS) {
    const original = app[method].bind(app);
    app[method] = (url, ...rest) => {
      seen.push({ method: method.toUpperCase(), url });
      return original(url, ...rest);
    };
  }
  const stubGateway = new Proxy(
    {},
    { get: () => () => undefined },
  );
  const stubProviders = new Proxy({}, { get: () => () => undefined });
  try {
    await registerRoutes(app, stubGateway, stubProviders, {
      dataDir: path.join(repoRoot, "backend"),
      appVersion: rootPkg.version ?? "0.0.0",
    });
  } finally {
    await app.close();
  }
  if (!seen.length) throw new Error("没有收集到任何路由（registerRoutes 变了？）");
  return seen.map((r) => ({ method: r.method, path: toOpenApiPath(r.url) }));
}

function operationId(method, openApiPath) {
  const words = openApiPath
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return [
    method.toLowerCase(),
    ...words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)),
  ].join("");
}

function buildDocument(routes) {
  const knownTags = new Set(OPENAPI_TAGS.map((t) => t.name));
  const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
  const problems = [];

  // 路由 → 契约：漏写就报（新接口忘了写契约）。
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (OPENAPI_ROUTE_META[key] || OPENAPI_EXCLUDE[key]) continue;
    problems.push(`路由没有契约（改成「注解」或加进 OPENAPI_EXCLUDE）：${key}`);
  }
  // 契约 → 路由：写了不存在的接口也要报。
  for (const key of [
    ...Object.keys(OPENAPI_ROUTE_META),
    ...Object.keys(OPENAPI_EXCLUDE),
  ]) {
    if (byKey.has(key)) continue;
    problems.push(`契约里有不存在的路由：${key}`);
  }
  for (const [key, meta] of Object.entries(OPENAPI_ROUTE_META)) {
    if (!meta.summary?.trim()) problems.push(`缺少 summary：${key}`);
    if (!meta.tags?.length) problems.push(`缺少 tags：${key}`);
    for (const tag of meta.tags ?? []) {
      if (!knownTags.has(tag)) problems.push(`未知 tag "${tag}"：${key}`);
    }
  }
  if (problems.length) {
    throw new Error(`契约与路由不一致：\n  - ${problems.join("\n  - ")}`);
  }

  const paths = {};
  for (const route of [...routes].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  )) {
    const key = `${route.method} ${route.path}`;
    const meta = OPENAPI_ROUTE_META[key];
    if (!meta) continue;
    const method = route.method.toLowerCase();
    paths[route.path] ??= {};
    paths[route.path][method] = {
      summary: meta.summary,
      ...(meta.description ? { description: meta.description } : {}),
      operationId: meta.operationId ?? operationId(route.method, route.path),
      tags: [...meta.tags],
      responses: meta.responses ?? { 200: { description: "OK" } },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: OPENAPI_INFO.title,
      version: rootPkg.version ?? "0.0.0",
      description: OPENAPI_INFO.description,
    },
    tags: OPENAPI_TAGS.map((t) => ({ ...t })),
    paths,
  };
}

const routes = await collectRoutes();
if (args.has("--list")) {
  for (const r of routes) console.log(r.method, r.path);
  console.log(`总计 ${routes.length} 条`);
  process.exit(0);
}

const doc = buildDocument(routes);
const json = `${JSON.stringify(doc, null, 2)}\n`;
const endpointCount = Object.values(doc.paths).reduce(
  (n, item) => n + Object.keys(item).length,
  0,
);

if (args.has("--check")) {
  const current = fs.existsSync(outFile)
    ? fs.readFileSync(outFile, "utf8")
    : "";
  if (current === json) {
    console.log(
      `✅ openapi 契约与路由一致（${endpointCount} 个端点，${outFile}）`,
    );
    process.exit(0);
  }
  const currentLines = current.split("\n");
  const nextLines = json.split("\n");
  const firstDiff = nextLines.findIndex((line, i) => line !== currentLines[i]);
  console.error(
    `❌ api/openapi.json 与当前路由/契约不一致（第 ${firstDiff + 1} 行起）：\n` +
      `    - 磁盘：${currentLines[firstDiff] ?? "<缺行>"}\n` +
      `    - 生成：${nextLines[firstDiff] ?? "<缺行>"}\n` +
      "  改完接口请跑 `npm run openapi:gen` 并把 api/openapi.json 一起提交。",
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const before = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
fs.writeFileSync(outFile, json);
console.log(
  `✅ 生成 ${outFile}（${endpointCount} 个端点 / ${Object.keys(doc.paths).length} 条路径）` +
    (before === json ? "，内容无变化" : ""),
);
