/**
 * 注入 agent 的仓库地址（**服务中心方案**）单测。
 *
 * 守住这几条：
 * 1. 仓库地址**只**来自服务中心：`project → department.departmentId`（组织 id）
 *    → `GET /v1/orgs/{orgId}/services`（含每个服务的 git 仓库地址）；
 * 2. 简报里出现的是服务中心给出的仓库，**老库里残留的项目级 `gitRepoUrl` 一个字都不许出现**；
 * 3. 服务中心不可达 / 项目没有所属组织 → 退回「按需自己 clone」的兜底文案（老行为），
 *    也没有项目级仓库地址可以回落；
 * 4. 交付目标那段（merge / deploy + 「不要在 agent 进程里同步跑发版脚本」）在注入仓库时照旧在；
 * 5. 接口 `GET /api/projects/:id/service-repos` 原样给出「会被注入什么」（可排查）。
 *
 * Usage: npx tsx backend/scripts/test-injected-repos.mjs   (或 npm test)
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
import { buildTaskBootstrap } from "../src/task-context.ts";
import {
  ServiceRegistryClient,
  buildOrgServiceList,
  normalizeOrgName,
  normalizeRegisteredServices,
  orgServicesUrl,
} from "../src/service-registry.ts";
import {
  DEFAULT_SERVICE_REGISTRY_API_URL,
  DEFAULT_SERVICE_REGISTRY_TIMEOUT_MS,
  resolveServiceRegistryApiUrl,
  resolveServiceRegistryTimeoutMs,
} from "../src/config.ts";

/** 项目上登记的（旧的）仓库地址：绝不能出现在简报里。 */
const PROJECT_LEVEL_URL = "https://github.com/example/PROJECT-LEVEL-URL.git";

const ORG_PAYLOAD = {
  limit: 200,
  offset: 0,
  org: { id: "D0005", name: "AI研发部", type: "研发", resolved: true },
  organization: { enabled: true, available: true, url: "http://127.0.0.1:4244" },
  services: [
    {
      namespace: "default",
      name: "agent-control-plane",
      type: "service",
      description: "Web Cursor Agent Gateway",
      gitRepoUrl: "https://github.com/kaulie/agent-control-plane.git",
      departmentId: "D0005",
      departmentName: "AI研发部",
      version: "5c6e3221",
      owner: "kaulie",
    },
    {
      namespace: "default",
      name: "agent-benchmark-tool",
      description: "agent评测",
      gitRepoUrl: "https://github.com/kaulie/agent-benchmark-tool",
      departmentId: "D0005",
    },
    // 没有仓库地址的服务：不进简报的 origin 候选，但不能丢掉。
    { namespace: "default", name: "no-repo-service", description: "还没登记仓库" },
    { namespace: "default", name: "  " },
    "junk",
  ],
};

// ---- 1) URL / 归一化 ----
assert.equal(
  orgServicesUrl("http://127.0.0.1:4240", "D0005"),
  "http://127.0.0.1:4240/v1/orgs/D0005/services",
);
assert.equal(
  orgServicesUrl("http://127.0.0.1:4240///", " D0005 "),
  "http://127.0.0.1:4240/v1/orgs/D0005/services",
);

const normalized = normalizeRegisteredServices(ORG_PAYLOAD);
assert.equal(normalized.length, 3, "丢掉无名字的行");
assert.deepEqual(
  normalized.map((s) => s.name),
  ["agent-control-plane", "agent-benchmark-tool", "no-repo-service"],
);
assert.equal(normalized[0].gitRepoUrl, "https://github.com/kaulie/agent-control-plane.git");
assert.equal(normalized[2].gitRepoUrl, undefined, "没登记仓库 → 不造字段");
assert.deepEqual(normalizeRegisteredServices(null), []);
assert.deepEqual(normalizeRegisteredServices({ services: "nope" }), []);
assert.equal(normalizeOrgName(ORG_PAYLOAD), "AI研发部");
assert.equal(normalizeOrgName({}), undefined);

const list = buildOrgServiceList(ORG_PAYLOAD, {
  orgId: "D0005",
  source: "http://127.0.0.1:4240",
  fetchedAt: "2026-09-20T01:00:00.000Z",
});
assert.equal(list.available, true);
assert.equal(list.orgId, "D0005");
assert.equal(list.orgName, "AI研发部");
assert.equal(list.fetchedAt, "2026-09-20T01:00:00.000Z");
assert.equal(list.error, undefined);


// ---- 2) 客户端：按组织查、带缓存、不可达降级 ----
{
  const seen = [];
  let clock = 1_000;
  const cacheClient = new ServiceRegistryClient({
    baseUrl: "http://127.0.0.1:4240",
    ttlMs: 30_000,
    now: () => clock,
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ORG_PAYLOAD };
    },
  });
  const first = await cacheClient.listByOrg("D0005");
  assert.equal(first.available, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "http://127.0.0.1:4240/v1/orgs/D0005/services");
  clock += 29_000;
  await cacheClient.listByOrg("D0005");
  assert.equal(seen.length, 1, "TTL 内不重复查");
  clock += 2_000;
  await cacheClient.listByOrg("D0005");
  assert.equal(seen.length, 2, "过 TTL 重查");
  await cacheClient.listByOrg("D0005", { refresh: true });
  assert.equal(seen.length, 3, "refresh 绕开缓存");
  // 另一个组织各查各的
  await cacheClient.listByOrg("D0002");
  assert.equal(seen[3], "http://127.0.0.1:4240/v1/orgs/D0002/services");
  // 空组织 id：不发请求，直接标不可用
  const none = await cacheClient.listByOrg("  ");
  assert.equal(none.available, false);
  assert.deepEqual(none.items, []);
  assert.equal(seen.length, 4);
}

{
  const down = new ServiceRegistryClient({
    baseUrl: "http://127.0.0.1:4240",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4240");
    },
  });
  const res = await down.listByOrg("D0005");
  assert.equal(res.available, false);
  assert.deepEqual(res.items, []);
  assert.match(res.error ?? "", /ECONNREFUSED/);
}

{
  const bad = new ServiceRegistryClient({
    baseUrl: "http://127.0.0.1:4240",
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const res = await bad.listByOrg("D0005");
  assert.equal(res.available, false);
  assert.match(res.error ?? "", /HTTP 503/);
}

// ---- 3) 环境变量解析 ----
assert.equal(resolveServiceRegistryApiUrl({}), DEFAULT_SERVICE_REGISTRY_API_URL);
assert.equal(
  resolveServiceRegistryApiUrl({ SERVICE_REGISTRY_API_URL: "http://127.0.0.1:5252/" }),
  "http://127.0.0.1:5252",
);
assert.equal(resolveServiceRegistryTimeoutMs({}), DEFAULT_SERVICE_REGISTRY_TIMEOUT_MS);
assert.equal(resolveServiceRegistryTimeoutMs({ SERVICE_REGISTRY_TIMEOUT_MS: "900" }), 900);
assert.equal(
  resolveServiceRegistryTimeoutMs({ SERVICE_REGISTRY_TIMEOUT_MS: "-1" }),
  DEFAULT_SERVICE_REGISTRY_TIMEOUT_MS,
);


// ---- 4) 简报：注入服务中心的仓库；老数据里残留的项目级 gitRepoUrl 一个字都不许出现 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-repos-"));
const store = new Store(dir);
const project = store.createProject("repos-test");
// 老的 git_repo_url 列还在（历史列，代码不再读写）：手工塞一个值，验证它绝不进简报。
store.db
  .prepare(`UPDATE projects SET git_repo_url = ? WHERE project_id = ?`)
  .run(PROJECT_LEVEL_URL, project.projectId);
// 项目「所属组织」= 组织服务的部门 id：注入就是靠它去查服务中心。
store.updateProjectSettings(project.projectId, {
  department: { departmentId: "D0005", departmentName: "AI研发部" },
});

const client = new ServiceRegistryClient({
  baseUrl: "http://127.0.0.1:4240",
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ORG_PAYLOAD }),
});
const provider = {
  name: "cursor",
  async verifyAuth() {
    return { ok: true, detail: "mock" };
  },
  async listModels() {
    return [];
  },
  async resolveModel() {
    return undefined;
  },
  async run() {
    return {
      status: "finished",
      result: "mock done",
      durationMs: 1,
      modelCalls: 1,
      toolCalls: 0,
      agentId: "agent-mock",
    };
  },
  async cancel() {
    return true;
  },
};
const registry = new ProviderRegistry("cursor", [provider]);
const gateway = new AgentGateway(
  store,
  registry,
  { agentWorkspaceRoot: path.join(dir, "ws"), dataDir: dir, serviceRegistry: client },
  () => {},
);

const task = store.createTask({
  taskId: "task-repos",
  title: "注入仓库地址",
  workspace: path.join(dir, "ws", "repos"),
  provider: "cursor",
  projectId: project.projectId,
  description: "让 agent 用服务中心的仓库地址。",
  goal: "deploy",
});

const bootstrapOf = (extra) =>
  buildTaskBootstrap({
    task: store.getTask(task.taskId),
    project: store.getProject(task.projectId),
    events: [],
    runs: [],
    ...extra,
  }).text;

const withRepos = bootstrapOf({
  orgServices: buildOrgServiceList(ORG_PAYLOAD, {
    orgId: "D0005",
    source: "http://127.0.0.1:4240",
  }),
});
assert.ok(withRepos.includes("Injected git repositories"));
assert.ok(withRepos.includes("org D0005 AI研发部"), "要写明是哪个组织");
assert.ok(
  withRepos.includes("`agent-control-plane` → `https://github.com/kaulie/agent-control-plane.git`"),
  "要给出服务名 + 仓库地址",
);
assert.ok(withRepos.includes("https://github.com/kaulie/agent-benchmark-tool"));
assert.ok(withRepos.includes("GET /v1/orgs/D0005/services"), "要写明来源（可自查）");
assert.ok(
  !withRepos.includes(PROJECT_LEVEL_URL),
  "老库里残留的项目级 gitRepoUrl 绝不能进简报（单一真源 = 服务中心）",
);
assert.ok(withRepos.includes("- goal: 合入主分支并部署上线 (deploy)"));
assert.ok(withRepos.includes("and then deploy it"));
assert.ok(withRepos.includes("Never** run a deploy/restart script"), "部署平台那条事实说明照旧");

// 服务中心不可达 / 项目没有组织 → 兜底文案（老行为），也没有项目级仓库地址可读
const fallback = bootstrapOf({});
assert.ok(!fallback.includes(PROJECT_LEVEL_URL));
assert.ok(fallback.includes("- Clone the repo you need into that directory (or a subfolder)"));
assert.ok(!fallback.includes("Injected git repositories"));

// 组织下没有任何带仓库的服务 → 也不列出一堆空行，走兜底
const noRepos = bootstrapOf({
  orgServices: buildOrgServiceList(
    { services: [{ name: "no-repo-service" }] },
    { orgId: "D0005", source: "http://127.0.0.1:4240" },
  ),
});
assert.ok(!noRepos.includes("Injected git repositories"));
assert.ok(!noRepos.includes(PROJECT_LEVEL_URL));

// ---- 5) 网关 + 接口：project → 组织 → 服务中心 ----
const repos = await gateway.getProjectServiceRepos(project.projectId);
assert.equal(repos.projectId, project.projectId);
assert.equal(repos.repos.orgId, "D0005");
assert.equal(repos.repos.available, true);
assert.equal(repos.repos.items.length, 3);

const app = Fastify({ logger: false });
await registerRoutes(app, gateway, registry, { dataDir: dir, appVersion: "0.0.0-test" });
const res = await app.inject({
  method: "GET",
  url: `/api/projects/${project.projectId}/service-repos`,
});
assert.equal(res.statusCode, 200, res.body);
const body = JSON.parse(res.body);
assert.equal(body.projectId, project.projectId);
assert.equal(body.repos.items[0].gitRepoUrl, "https://github.com/kaulie/agent-control-plane.git");
assert.equal(
  (await app.inject({ method: "GET", url: "/api/projects/project-nope/service-repos" })).statusCode,
  404,
);
await app.close();

console.log("✅ injected repos OK");
