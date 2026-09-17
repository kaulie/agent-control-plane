/**
 * Organization-service client: department parsing, base-URL handling, cache TTL
 * and graceful degradation when the service is unreachable.
 *
 * Usage: npx tsx backend/scripts/test-organization.mjs   (or: npm test)
 */
import assert from "node:assert/strict";
import {
  DEFAULT_ORGANIZATION_API_URL,
  DEFAULT_ORGANIZATION_TIMEOUT_MS,
  resolveOrganizationApiUrl,
  resolveOrganizationTimeoutMs,
} from "../src/config.ts";
import {
  OrganizationClient,
  buildDepartmentList,
  departmentsUrl,
  normalizeDepartmentTypes,
  normalizeDepartments,
} from "../src/organization.ts";

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

const SERVICE_PAYLOAD = {
  items: [
    { id: "D0002", name: "工程效能部门", type: "研发", createdAt: "2026-09-17T05:05:47Z" },
    { id: "D0001", name: "SRE部门", type: "研发", createdAt: "2026-09-17T05:05:36Z" },
    { id: "D0003", name: "AI架构部门", type: "研发" },
  ],
  types: ["研发", "测试", "产品", "管理"],
};

await check("departmentsUrl joins without doubling slashes", () => {
  assert.equal(
    departmentsUrl("http://127.0.0.1:4244"),
    "http://127.0.0.1:4244/api/v1/departments",
  );
  assert.equal(
    departmentsUrl("http://127.0.0.1:4244///"),
    "http://127.0.0.1:4244/api/v1/departments",
  );
});

await check("normalizeDepartments reads the service shape, keeping its order", () => {
  const items = normalizeDepartments(SERVICE_PAYLOAD);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((d) => d.id),
    ["D0002", "D0001", "D0003"],
  );
  assert.deepEqual(items[2], { id: "D0003", name: "AI架构部门", type: "研发" });
});

await check("normalizeDepartments accepts a bare array and skips junk", () => {
  const items = normalizeDepartments([
    { id: "D1", name: "一" },
    { name: "二号" },
    { id: "D1", name: "重复 id 丢弃" },
    { id: "  " },
    null,
    "nope",
  ]);
  assert.deepEqual(items, [
    { id: "D1", name: "一" },
    { id: "二号", name: "二号" },
  ]);
});

await check("normalizeDepartments tolerates unknown payloads", () => {
  assert.deepEqual(normalizeDepartments(null), []);
  assert.deepEqual(normalizeDepartments({}), []);
  assert.deepEqual(normalizeDepartments({ items: "nope" }), []);
});

await check("normalizeDepartmentTypes de-duplicates and trims", () => {
  assert.deepEqual(normalizeDepartmentTypes(SERVICE_PAYLOAD), [
    "研发",
    "测试",
    "产品",
    "管理",
  ]);
  assert.deepEqual(normalizeDepartmentTypes({ types: [" 研发 ", "", 42, "研发"] }), ["研发"]);
  assert.deepEqual(normalizeDepartmentTypes(undefined), []);
});

await check("buildDepartmentList marks the source and timestamp", () => {
  const list = buildDepartmentList(SERVICE_PAYLOAD, {
    source: "http://127.0.0.1:4244",
    fetchedAt: "2026-09-17T05:10:00.000Z",
  });
  assert.equal(list.available, true);
  assert.equal(list.source, "http://127.0.0.1:4244");
  assert.equal(list.fetchedAt, "2026-09-17T05:10:00.000Z");
  assert.equal(list.items.length, 3);
  assert.equal(list.error, undefined);
});

await check("client caches a successful lookup", async () => {
  let calls = 0;
  let clock = 1_000;
  const client = new OrganizationClient({
    baseUrl: "http://127.0.0.1:4244",
    ttlMs: 30_000,
    now: () => clock,
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, "http://127.0.0.1:4244/api/v1/departments");
      return { ok: true, status: 200, json: async () => SERVICE_PAYLOAD };
    },
  });

  const first = await client.list();
  assert.equal(first.available, true);
  assert.equal(calls, 1);

  clock += 29_000;
  await client.list();
  assert.equal(calls, 1, "inside TTL → no refetch");

  clock += 2_000; // past TTL
  await client.list();
  assert.equal(calls, 2, "past TTL → refetch");

  await client.list({ refresh: true });
  assert.equal(calls, 3, "refresh=1 bypasses the cache");
});

await check("client degrades to available:false when the service is down", async () => {
  const client = new OrganizationClient({
    baseUrl: "http://127.0.0.1:4244",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4244");
    },
  });
  const list = await client.list();
  assert.equal(list.available, false);
  assert.deepEqual(list.items, []);
  assert.match(list.error ?? "", /ECONNREFUSED/);
});

await check("client reports non-2xx as unavailable", async () => {
  const client = new OrganizationClient({
    baseUrl: "http://127.0.0.1:4244",
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const list = await client.list();
  assert.equal(list.available, false);
  assert.match(list.error ?? "", /HTTP 503/);
});

await check("organization env resolution", () => {
  assert.equal(resolveOrganizationApiUrl({}), DEFAULT_ORGANIZATION_API_URL);
  assert.equal(resolveOrganizationApiUrl({ ORGANIZATION_API_URL: "   " }), DEFAULT_ORGANIZATION_API_URL);
  assert.equal(
    resolveOrganizationApiUrl({ ORGANIZATION_API_URL: "http://127.0.0.1:4444/" }),
    "http://127.0.0.1:4444",
  );
  assert.equal(resolveOrganizationTimeoutMs({}), DEFAULT_ORGANIZATION_TIMEOUT_MS);
  assert.equal(resolveOrganizationTimeoutMs({ ORGANIZATION_TIMEOUT_MS: "800" }), 800);
  assert.equal(resolveOrganizationTimeoutMs({ ORGANIZATION_TIMEOUT_MS: "abc" }), DEFAULT_ORGANIZATION_TIMEOUT_MS);
  assert.equal(resolveOrganizationTimeoutMs({ ORGANIZATION_TIMEOUT_MS: "-5" }), DEFAULT_ORGANIZATION_TIMEOUT_MS);
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: organization department client");
