/**
 * `GET /api/auth` 的展示口径：`detail` 就是右上角状态条显示的那行字。
 *
 * 以前默认 provider 命中时会拼成 `default=<name>: <detail>`，右上角就成了
 * `default=cursor: authenticated as a@b.com` —— 前缀对用户没意义，还挡着「到底用的哪个
 * 账号」。这条守住：默认 provider 命中时**直接用 provider 自己的文案**；只有默认 provider
 * 不在结果里时，才退回 `name: detail; name: detail` 的合并形式。
 *
 * 用法：npx tsx backend/scripts/test-auth-status.mjs   （或：npm test）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Store } from "../src/store/db.ts";
import { AgentGateway } from "../src/gateway/gateway.ts";
import { registerRoutes } from "../src/http/routes.ts";

const APP_VERSION = "0.0.0-test";
const CURSOR_DETAIL = "authenticated as a@b.com";
const CLINE_DETAIL = 'provider "deepseek" configured (key present)';

/** 假 providers 注册表：`/api/auth` 只用 name / verifyAuth / defaultProviderName / list。 */
function makeProviders(defaultProviderName) {
  const cursor = {
    name: "cursor",
    verifyAuth: async () => ({ ok: true, detail: CURSOR_DETAIL }),
    listModels: async () => [],
  };
  const cline = {
    name: "cline",
    verifyAuth: async () => ({ ok: true, detail: CLINE_DETAIL }),
    listModels: async () => [],
  };
  const all = [cursor, cline];
  const byName = new Map(all.map((p) => [p.name, p]));
  return {
    has: (n) => byName.has(n),
    names: () => all.map((p) => p.name),
    defaultProviderName,
    get: (n) => byName.get(n),
    get default() {
      return byName.get(defaultProviderName);
    },
    list: () => all,
    reconcileAfterRestart: async () => {},
  };
}

async function authBody(defaultProviderName) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-auth-status-"));
  const providers = makeProviders(defaultProviderName);
  const store = new Store(dataDir);
  const gateway = new AgentGateway(
    store,
    providers,
    { agentWorkspaceRoot: path.join(dataDir, "ws"), dataDir },
    () => {},
  );
  const app = Fastify({ logger: false });
  await registerRoutes(app, gateway, providers, { dataDir, appVersion: APP_VERSION });
  const res = await app.inject({ method: "GET", url: "/api/auth" });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body);
}

// 1) 默认 provider 命中 → 直接用它的文案（右上角不带 `default=cursor: ` 前缀）
{
  const body = await authBody("cursor");
  assert.equal(body.ok, true);
  assert.equal(body.detail, CURSOR_DETAIL, "默认 provider 命中时 detail = provider 自己的文案");
  assert.ok(!/default=/.test(body.detail), "detail 不再带 default=<name>: 前缀");
  assert.match(body.detail, /a@b\.com/, "账号/邮箱可读");
  assert.equal(body.providers.length, 2, "providers 明细照旧保留（设置页要用）");
  assert.equal(body.providers[0].name, "cursor");
}

// 2) 默认 provider 不在结果里 → 才退回 `name: detail; name: detail`
{
  const body = await authBody("not-registered");
  assert.equal(body.detail, `cursor: ${CURSOR_DETAIL}; cline: ${CLINE_DETAIL}`);
}

// 3) 默认 provider 鉴权失败 → 直接给出失败原因（不再套前缀，看不出 provider 也没关系：
//    文案本身自带上下文；设置页仍能看到 isDefault 归属）
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-auth-status-"));
  const providers = makeProviders("cursor");
  const failing = { ...providers, list: () => [
    { name: "cursor", verifyAuth: async () => ({ ok: false, detail: "missing API key" }), listModels: async () => [] },
  ] };
  const store = new Store(dataDir);
  const gateway = new AgentGateway(
    store,
    failing,
    { agentWorkspaceRoot: path.join(dataDir, "ws"), dataDir },
    () => {},
  );
  const app = Fastify({ logger: false });
  await registerRoutes(app, gateway, failing, { dataDir, appVersion: APP_VERSION });
  const body = JSON.parse((await app.inject({ method: "GET", url: "/api/auth" })).body);
  assert.equal(body.ok, false);
  assert.equal(body.detail, "missing API key");
}

console.log("PASS: /api/auth 展示口径（不再带 default=<name>: 前缀）");
