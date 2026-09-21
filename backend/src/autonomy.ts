/**
 * Client for the **autonomy** runtime（自治系统核心服务，`~/runtime/autonomy`，契约端口 4300）。
 *
 * 用途：新建任务的第二个入口 ——「交给 autonomy」把指令 POST 给它的 `POST /api/tasks`，由
 * autonomy 自己的 agent 执行。控制面**不落库**：任务与对话数据的唯一真源是 autonomy，页面
 * 数据全部经这里代理（见 `docs/autonomy-integration.md`）。
 *
 * 契约（对着运行中的服务实测，2026-09-21 / version ff9899c0）：
 *
 *   GET  /health                    → { status, llm_backend, llm_model, turns }（部署平台探活路径）
 *   GET  /api/meta                  → { service, version, reason_turns, has_tasks_table, turns }
 *   POST /api/tasks                 → 202 { task_id, agent_id, status, message_id, queued }
 *         body: { description, context_ref: { project } }
 *   GET  /api/tasks?project_id=<id> → { tasks: [{ id, description, status, turns, last_at, project_id, agent_id, updated_at }] }
 *   GET  /api/tasks/{task_id}       → { task_id, description, domain, status, error, goal_type,
 *                                       context_ref, agent_id, created_at, updated_at,
 *                                       project: { id, name?, git_repo_url, organization? },
 *                                       plans: [{ ... steps: [{ status, input, output, error }] }] }
 *   未知 id → 404 {"error":"task not found"}；错误统一 {"error":"…"}
 *
 * 两条不同的失败语义（很重要）：
 * - **读**（status / listTasks / getTask）：best-effort —— 带 TTL 缓存、**从不抛异常**，不可达时
 *   返回 `available: false` + 原因，让页面显示「autonomy 不可达」而不是 500。
 * - **写**（createTask）：**绝不静默降级** —— 失败返回 `{ ok: false, ... }`，由路由转成 503/4xx，
 *   把 autonomy 的原文带出给用户（契约第 0 节：不落库、不回落成本机 agent 执行）。
 */

const META_PATH = "/api/meta";
const HEALTH_PATH = "/health";
const TASKS_PATH = "/api/tasks";

/** Default cache TTL for a successful lookup. */
const DEFAULT_TTL_MS = 30_000;
/** Failures are cached only briefly so a restart of the service is picked up. */
const DEFAULT_FAILURE_TTL_MS = 5_000;

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface AutonomyClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  ttlMs?: number;
  failureTtlMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** `GET /health` + `GET /api/meta` 合并出来的自述（给「新入口能不能点」用）。 */
export interface AutonomyStatus {
  available: boolean;
  /** autonomy 的 base URL（便于页面上写清数据源）。 */
  url: string;
  /** 部署的 APP_VERSION（`go run` 时是 `dev`）。 */
  version?: string;
  /** 当前的 LLM 后端（`cursor` / `cline`）与模型 —— 由 autonomy 进程决定，我们选不了。 */
  llmBackend?: string;
  llmModel?: string;
  /** 日志条数（autonomy 自己的计数，便于「探到的是不是正在写的那个库」）。 */
  turns?: number;
  error?: string;
  fetchedAt: string;
}

/** `GET /api/tasks` 的一行（实测字段，含契约 A3 追加的三个）。 */
export interface AutonomyTaskSummary {
  id: string;
  description: string;
  status: string;
  turns: number;
  lastAt: string;
  projectId?: string;
  agentId?: number;
  updatedAt?: string;
}

export interface AutonomyTaskListResult {
  available: boolean;
  tasks: AutonomyTaskSummary[];
  url: string;
  error?: string;
  fetchedAt: string;
}

/** `GET /api/tasks/{id}`（只保留我们页面会用到的部分，其余原样透传）。 */
export type AutonomyTaskDetail = Record<string, unknown>;

export interface AutonomyTaskDetailResult {
  available: boolean;
  task?: AutonomyTaskDetail;
  /** 服务端 HTTP 状态码（404 = 没有这条 task，路由原样透传）。 */
  status: number;
  error?: string;
  fetchedAt: string;
}

export type AutonomyCreateResult =
  | {
      ok: true;
      taskId: string;
      agentId?: number;
      status?: string;
      messageId?: number;
      queued?: number;
    }
  | { ok: false; /** 服务端状态码（有的话）；网络/超时错误没有。 */ httpStatus?: number; error: string };

/**
 * 追加一条指令给**已存在**的执行方任务（chat 输入）。
 *
 * 与 `createTask` 是同一个入口（`POST /api/tasks`）带 `task_id` —— 契约 A2：同一个 `task_id`
 * 再 POST = 给同一条 task 的那只 agent 追加一条指令，**忙则排队**（不会被拒），
 * 所以它同样是**写**：失败原样带出（`httpStatus`），绝不静默降级。
 */
export type AutonomyInstructionResult = AutonomyCreateResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 把 autonomy 的错误体（`{"error":"…"}`）抽成一行可显示的原文。 */
export function readAutonomyError(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    const err = payload.error;
    if (typeof err === "string" && err.trim()) return err.trim();
  }
  return fallback;
}

/** `GET /api/tasks` 一行 → 归一化（缺字段不补假值，缺 `id` 的行直接丢掉）。 */
export function normalizeTaskSummary(payload: unknown): AutonomyTaskSummary | null {
  if (!isRecord(payload)) return null;
  const id = trimmedString(payload.id);
  if (!id) return null;
  const projectId = trimmedString(payload.project_id);
  const updatedAt = trimmedString(payload.updated_at);
  const agentId = numberOrUndefined(payload.agent_id);
  return {
    id,
    description: trimmedString(payload.description),
    status: trimmedString(payload.status),
    turns: numberOrUndefined(payload.turns) ?? 0,
    lastAt: trimmedString(payload.last_at),
    ...(projectId ? { projectId } : {}),
    ...(agentId != null ? { agentId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function normalizeTaskList(payload: unknown): AutonomyTaskSummary[] {
  const rows = isRecord(payload) && Array.isArray(payload.tasks) ? payload.tasks : [];
  return rows
    .map((row) => normalizeTaskSummary(row))
    .filter((row): row is AutonomyTaskSummary => row != null);
}

/** `POST /api/tasks` 的 202 响应 → 接受信息（缺 `task_id` 视为失败）。 */
export function normalizeCreateResult(payload: unknown): AutonomyCreateResult {
  if (!isRecord(payload)) {
    return { ok: false, error: "autonomy 返回了非对象响应" };
  }
  const taskId = trimmedString(payload.task_id);
  if (!taskId) {
    return { ok: false, error: readAutonomyError(payload, "autonomy 没有返回 task_id") };
  }
  const agentId = numberOrUndefined(payload.agent_id);
  const status = trimmedString(payload.status);
  const messageId = numberOrUndefined(payload.message_id);
  const queued = numberOrUndefined(payload.queued);
  return {
    ok: true,
    taskId,
    ...(agentId != null ? { agentId } : {}),
    ...(status ? { status } : {}),
    ...(messageId != null ? { messageId } : {}),
    ...(queued != null ? { queued } : {}),
  };
}

export function autonomyTasksUrl(baseUrl: string, projectId?: string): string {
  const base = `${baseUrl.replace(/\/+$/, "")}${TASKS_PATH}`;
  const project = projectId?.trim();
  return project ? `${base}?project_id=${encodeURIComponent(project)}` : base;
}

export class AutonomyClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private statusCache: { at: number; value: AutonomyStatus } | null = null;

  constructor(options: AutonomyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
  }

  get url(): string {
    return this.baseUrl;
  }

  /** 可用性 + 版本 + LLM 后端（带缓存，从不抛：不可达 → `available: false`）。 */
  async status(options: { refresh?: boolean } = {}): Promise<AutonomyStatus> {
    const now = this.now();
    if (this.statusCache && !options.refresh) {
      const age = now - this.statusCache.at;
      const ttl = this.statusCache.value.available ? this.ttlMs : this.failureTtlMs;
      if (age < ttl) return this.statusCache.value;
    }
    const value = await this.fetchStatus();
    this.statusCache = { at: now, value };
    return value;
  }

  /** 任务列表（可按 project 过滤；契约 A3）。 */
  async listTasks(opts: { projectId?: string } = {}): Promise<AutonomyTaskListResult> {
    const url = autonomyTasksUrl(this.baseUrl, opts.projectId);
    try {
      const res = await this.get(url);
      if (!res.ok) return this.unavailableList(`autonomy 返回 HTTP ${res.status}`);
      const payload = await res.json();
      return {
        available: true,
        tasks: normalizeTaskList(payload),
        url: this.baseUrl,
        fetchedAt: new Date(this.now()).toISOString(),
      };
    } catch (err) {
      return this.unavailableList(this.reason(err));
    }
  }

  /** 任务详情 / 进展（404 原样带出，供路由透传）。 */
  async getTask(taskId: string): Promise<AutonomyTaskDetailResult> {
    const id = taskId.trim();
    const base = {
      available: false,
      status: 0,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    if (!id) return { ...base, status: 400, error: "taskId is required" };
    try {
      const res = await this.get(`${this.baseUrl}${TASKS_PATH}/${encodeURIComponent(id)}`);
      const payload = await res.json().catch(() => undefined);
      if (!res.ok) {
        return {
          ...base,
          status: res.status,
          error: readAutonomyError(payload, `autonomy 返回 HTTP ${res.status}`),
        };
      }
      return {
        available: true,
        status: 200,
        task: isRecord(payload) ? payload : undefined,
        fetchedAt: new Date(this.now()).toISOString(),
      };
    } catch (err) {
      return { ...base, error: this.reason(err) };
    }
  }

  /**
   * 投递一条任务指令（「交给 autonomy」入口）。
   *
   * 与读接口相反：**失败就是失败**，调用方（路由）用 `httpStatus` 决定 4xx 还是 503，
   * 并把 `error` 原文显示给用户 —— 绝不静默回落成本机 agent 执行。
   */
  async createTask(input: {
    description: string;
    projectId?: string;
  }): Promise<AutonomyCreateResult> {
    const description = input.description.trim();
    const projectId = input.projectId?.trim();
    if (!description) return { ok: false, error: "description is required (任务描述必填)" };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${TASKS_PATH}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          description,
          ...(projectId ? { context_ref: { project: projectId } } : {}),
        }),
      });
      const payload = await res.json().catch(() => undefined);
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: readAutonomyError(payload, `autonomy 返回 HTTP ${res.status}`),
        };
      }
      return normalizeCreateResult(payload);
    } catch (err) {
      return { ok: false, error: this.reason(err) };
    }
  }

  /**
   * 追加一条指令给**已存在**的执行方任务（chat 输入）。
   *
   * 与 `createTask` 走同一个入口，区别只有 `task_id`：autonomy 会把它当成「同一条 task 的下一条
   * 指令」投进那只 agent 的 inbox（忙则排队），返回 `202 { task_id, agent_id, status, message_id, queued }`。
   *
   * 与读接口相反：**失败就是失败**（同 `createTask`）——由路由转成 4xx/503，把原文带出给用户。
   */
  async addInstruction(input: {
    taskId: string;
    message: string;
  }): Promise<AutonomyInstructionResult> {
    const taskId = input.taskId.trim();
    const message = input.message.trim();
    if (!taskId) return { ok: false, httpStatus: 400, error: "taskId is required（执行方那边的 task id）" };
    if (!message) {
      return { ok: false, httpStatus: 400, error: "message is required（投递的指令不能为空）" };
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${TASKS_PATH}`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ task_id: taskId, description: message }),
      });
      const payload = await res.json().catch(() => undefined);
      if (!res.ok) {
        return {
          ok: false,
          httpStatus: res.status,
          error: readAutonomyError(payload, `autonomy 返回 HTTP ${res.status}`),
        };
      }
      return normalizeCreateResult(payload);
    } catch (err) {
      return { ok: false, error: this.reason(err) };
    }
  }

  private async fetchStatus(): Promise<AutonomyStatus> {
    const fetchedAt = new Date(this.now()).toISOString();
    const base: AutonomyStatus = { available: false, url: this.baseUrl, fetchedAt };
    const [meta, health] = await Promise.all([
      this.getJson(META_PATH),
      this.getJson(HEALTH_PATH),
    ]);
    if (!meta.ok && !health.ok) {
      return { ...base, error: meta.error ?? health.error ?? "autonomy 不可达" };
    }
    const metaBody = isRecord(meta.body) ? meta.body : {};
    const healthBody = isRecord(health.body) ? health.body : {};
    const version = trimmedString(metaBody.version);
    const llmBackend = trimmedString(healthBody.llm_backend);
    const llmModel = trimmedString(healthBody.llm_model);
    const turns = numberOrUndefined(healthBody.turns) ?? numberOrUndefined(metaBody.turns);
    return {
      available: true,
      url: this.baseUrl,
      ...(version ? { version } : {}),
      ...(llmBackend ? { llmBackend } : {}),
      ...(llmModel ? { llmModel } : {}),
      ...(turns != null ? { turns } : {}),
      fetchedAt,
    };
  }

  private async getJson(path: string): Promise<{ ok: boolean; status: number; body?: unknown; error?: string }> {
    try {
      const res = await this.get(`${this.baseUrl}${path}`);
      const body = await res.json().catch(() => undefined);
      if (!res.ok) {
        return { ok: false, status: res.status, error: readAutonomyError(body, `autonomy 返回 HTTP ${res.status}`) };
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      return { ok: false, status: 0, error: this.reason(err) };
    }
  }

  private get(url: string) {
    return this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "application/json" },
    });
  }

  private reason(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return `autonomy 超时（>${this.timeoutMs}ms）`;
      }
      return err.message;
    }
    return String(err);
  }

  private unavailableList(error: string): AutonomyTaskListResult {
    return {
      available: false,
      tasks: [],
      url: this.baseUrl,
      error,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }
}
