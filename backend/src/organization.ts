/**
 * Read-only client for the organization service (`~/runtime/organization`,
 * default http://127.0.0.1:4244) — used by project settings to offer the
 * department catalogue.
 *
 * Contract (verified against the running service):
 *
 *   GET /api/v1/departments
 *   → { "items": [{ "id": "D0001", "name": "SRE部门", "type": "研发", … }],
 *       "types": ["研发", "测试", "产品", "管理"] }
 *
 * The catalogue is best-effort: when the service is down we return
 * `available: false` instead of throwing, so the settings page keeps the
 * already-stored department and just shows "组织服务不可达".
 */
import type { DepartmentInfo, DepartmentList } from "./types.js";

const DEPARTMENTS_PATH = "/api/v1/departments";

/** Default cache TTL for a successful lookup. */
const DEFAULT_TTL_MS = 30_000;
/** Failures are cached only briefly so a restart of the service is picked up. */
const DEFAULT_FAILURE_TTL_MS = 5_000;

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface OrganizationClientOptions {
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

/**
 * Accept `{items: [...]}` (organization service) or a bare array, drop rows
 * without an id/name and de-duplicate by id. The service's own order is kept —
 * the catalogue is curated there (D0001, D0002, …).
 */
export function normalizeDepartments(payload: unknown): DepartmentInfo[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : [];
  const byKey = new Map<string, DepartmentInfo>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = trimmedString(row.id);
    const name = trimmedString(row.name);
    if (!id && !name) continue;
    const key = id || name;
    if (byKey.has(key)) continue;
    const type = trimmedString(row.type);
    byKey.set(key, {
      id: id || name,
      name: name || id,
      ...(type ? { type } : {}),
    });
  }
  return [...byKey.values()];
}

/** `types` is optional sugar from the service; unknown shape → no types. */
export function normalizeDepartmentTypes(payload: unknown): string[] {
  const raw = isRecord(payload) && Array.isArray(payload.types) ? payload.types : [];
  const seen = new Set<string>();
  for (const item of raw) {
    const type = trimmedString(item);
    if (type) seen.add(type);
  }
  return [...seen];
}

export function departmentsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${DEPARTMENTS_PATH}`;
}

/** Build a successful list result from a raw service payload. */
export function buildDepartmentList(
  payload: unknown,
  opts: { source: string; fetchedAt?: string },
): DepartmentList {
  return {
    available: true,
    items: normalizeDepartments(payload),
    types: normalizeDepartmentTypes(payload),
    source: opts.source,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
  };
}

export class OrganizationClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private cache: { at: number; list: DepartmentList } | null = null;

  constructor(options: OrganizationClientOptions) {
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

  /** Departments from the organization service (cached, never throws). */
  async list(options: { refresh?: boolean } = {}): Promise<DepartmentList> {
    const now = this.now();
    if (this.cache && !options.refresh) {
      const age = now - this.cache.at;
      const ttl = this.cache.list.available ? this.ttlMs : this.failureTtlMs;
      if (age < ttl) return this.cache.list;
    }
    const list = await this.fetchDepartments();
    this.cache = { at: now, list };
    return list;
  }

  private async fetchDepartments(): Promise<DepartmentList> {
    const url = departmentsUrl(this.baseUrl);
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        return this.unavailable(`组织服务返回 HTTP ${res.status}`);
      }
      const payload = await res.json();
      return buildDepartmentList(payload, {
        source: this.baseUrl,
        fetchedAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.name === "TimeoutError" || err.name === "AbortError"
            ? `组织服务超时（>${this.timeoutMs}ms）`
            : err.message
          : String(err);
      return this.unavailable(reason);
    }
  }

  private unavailable(error: string): DepartmentList {
    return {
      available: false,
      items: [],
      types: [],
      source: this.baseUrl,
      fetchedAt: new Date(this.now()).toISOString(),
      error,
    };
  }
}
