/**
 * Read-only client for the **service registry**（服务中心，
 * `~/runtime/service-registry`, default http://127.0.0.1:4240）.
 *
 * 用途：给 agent 简报注入「本组织下有哪些服务、各自的 git 仓库地址」。
 * 单一真源是服务中心 —— 应用里已经没有项目级 `gitRepoUrl`（接口不返回、UI 不展示）。
 *
 * Contract (verified against the running service):
 *
 *   GET /v1/orgs/{orgId}/services
 *   → { "org": { "id": "D0005", "name": "AI研发部", "resolved": true, … },
 *       "organization": { "available": true, "url": "http://127.0.0.1:4244", … },
 *       "services": [{ "namespace": "default", "name": "agent-control-plane",
 *                      "description": "…", "gitRepoUrl": "https://github.com/kaulie/agent-control-plane.git",
 *                      "departmentId": "D0005", "departmentName": "AI研发部",
 *                      "version": "5c6e3221", "owner": "kaulie", "type": "service", … }],
 *       "limit": 200, "offset": 0 }
 *
 * 这是服务中心自己的「组织视角」接口（面板上的 `curl /v1/orgs/D0001/services`）：
 * 按组织（= 组织服务的部门 id）列出服务，组织信息由服务中心向组织服务对齐
 * （组织服务不可达时它仍返回已登记的服务）。
 *
 * 与 organization 客户端同一套路：best-effort、带 TTL 缓存、**从不抛异常** ——
 * 服务中心不可达时返回 `available: false`，简报退回到「按需自己 clone」的兜底文案。
 */
import type { OrgServiceList, RegisteredService } from "./types.js";

/** Default cache TTL for a successful lookup. */
const DEFAULT_TTL_MS = 30_000;
/** Failures are cached only briefly so a registry restart is picked up. */
const DEFAULT_FAILURE_TTL_MS = 5_000;

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ServiceRegistryClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  ttlMs?: number;
  failureTtlMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests. */
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `GET /v1/orgs/{orgId}/services`（组织视角）的 URL。 */
export function orgServicesUrl(baseUrl: string, orgId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/orgs/${encodeURIComponent(orgId.trim())}/services`;
}


/**
 * Accept `{services: [...]}` (org view) / `{items: [...]}` / a bare array, keep only
 * rows with a usable name, de-duplicate by `namespace/name`. Order is the registry's
 * own (curated there), so the briefing stays stable across calls.
 */
export function normalizeRegisteredServices(payload: unknown): RegisteredService[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.services)
      ? payload.services
      : isRecord(payload) && Array.isArray(payload.items)
        ? payload.items
        : [];
  const byKey = new Map<string, RegisteredService>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = trimmedString(row.name);
    if (!name) continue;
    const namespace = trimmedString(row.namespace);
    const key = `${namespace}/${name}`;
    if (byKey.has(key)) continue;
    const description = trimmedString(row.description);
    const gitRepoUrl = trimmedString(row.gitRepoUrl);
    const departmentId = trimmedString(row.departmentId);
    const departmentName = trimmedString(row.departmentName);
    const version = trimmedString(row.version);
    const owner = trimmedString(row.owner);
    const type = trimmedString(row.type);
    byKey.set(key, {
      name,
      ...(namespace ? { namespace } : {}),
      ...(description ? { description } : {}),
      ...(gitRepoUrl ? { gitRepoUrl } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(departmentName ? { departmentName } : {}),
      ...(version ? { version } : {}),
      ...(owner ? { owner } : {}),
      ...(type ? { type } : {}),
    });
  }
  return [...byKey.values()];
}

/** `org.name` from the org view (服务中心从组织服务对齐来的名字快照)。 */
export function normalizeOrgName(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.org)) return undefined;
  const name = trimmedString(payload.org.name);
  return name || undefined;
}

/** Build a successful list result from a raw registry payload. */
export function buildOrgServiceList(
  payload: unknown,
  opts: { orgId: string; source: string; fetchedAt?: string },
): OrgServiceList {
  const orgName = normalizeOrgName(payload);
  return {
    available: true,
    orgId: opts.orgId,
    ...(orgName ? { orgName } : {}),
    items: normalizeRegisteredServices(payload),
    source: opts.source,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
  };
}


export class ServiceRegistryClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  /** Per-org cache（同一个组织下会连续建多个 task）。 */
  private readonly cache = new Map<string, { at: number; list: OrgServiceList }>();

  constructor(options: ServiceRegistryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
  }

  get source(): string {
    return this.baseUrl;
  }

  /**
   * 某个组织下登记的服务（含 git 仓库地址）。**从不抛异常**：
   * 空 orgId / 服务不可达 → `available: false`（调用方据此退回兜底文案）。
   */
  async listByOrg(orgId: string, options: { refresh?: boolean } = {}): Promise<OrgServiceList> {
    const id = orgId.trim();
    if (!id) {
      return this.unavailable(
        "",
        "project has no organization (department) to look services up by",
      );
    }
    const cached = this.cache.get(id);
    if (cached && !options.refresh) {
      const age = this.now() - cached.at;
      const ttl = cached.list.available ? this.ttlMs : this.failureTtlMs;
      if (age < ttl) return cached.list;
    }
    const list = await this.fetchServices(id);
    this.cache.set(id, { at: this.now(), list });
    return list;
  }

  private async fetchServices(orgId: string): Promise<OrgServiceList> {
    const url = orgServicesUrl(this.baseUrl, orgId);
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        return this.unavailable(orgId, `服务中心返回 HTTP ${res.status}`);
      }
      const payload = await res.json();
      return buildOrgServiceList(payload, {
        orgId,
        source: this.baseUrl,
        fetchedAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.name === "TimeoutError" || err.name === "AbortError"
            ? `服务中心超时（>${this.timeoutMs}ms）`
            : err.message
          : String(err);
      return this.unavailable(orgId, reason);
    }
  }

  private unavailable(orgId: string, error: string): OrgServiceList {
    return {
      available: false,
      orgId,
      items: [],
      source: this.baseUrl,
      fetchedAt: new Date(this.now()).toISOString(),
      error,
    };
  }
}
