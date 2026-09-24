import type {
  AgentBoard,
  ProviderAccount,
  AutonomyAccountList,
  AutonomyMeta,
  AutonomyTaskDetail,
  AutonomyTaskList,
  AgentBoardScope,
  AgentEvent,
  AgentRuntimeStatus,
  AgentTimeline,
  AppSettings,
  AuthStatus,
  DepartmentConfig,
  DepartmentList,
  ModelInfo,
  Project,
  ProjectSettingsView,
  ProviderInfo,
  Task,
  TaskDetail,
  TaskGoal,
  TaskType,
  TokenUsage,
  TokenUsageSeries,
  UsageGranularity,
  UsageTimeZone,
} from "./types";
import { APP_VERSION } from "./version";
import {
  checkUiVersionForWrite,
  reportStaleWrite,
  UI_VERSION_HEADER,
  UI_VERSION_MISMATCH_CODE,
} from "./version-check";

const BASE = "/api";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/** Human-readable text for anything thrown by the API layer. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Thrown when a write was refused because this page is not the version the
 * project currently serves. The write was NOT applied — refresh and retry.
 */
export class StaleUiVersionError extends Error {
  readonly code = UI_VERSION_MISMATCH_CODE;
  readonly mustRefresh = true;
  constructor(
    readonly clientVersion: string,
    readonly serverVersion: string | null,
  ) {
    super(
      serverVersion
        ? `页面版本（${clientVersion}）与项目当前版本（${serverVersion}）不一致，本次提交已被拒绝。请先刷新页面，再重新提交。`
        : `页面版本已过期，无法确认与项目当前版本一致，本次提交已被拒绝。请先刷新页面，再重新提交。`,
    );
    this.name = "StaleUiVersionError";
  }
}

/** Gateway rejection body for a stale-page write. */
type UiVersionMismatchBody = {
  code?: string;
  clientVersion?: string | null;
  serverVersion?: string | null;
};

/** Reads the guard's 409/428 answer; null when this is some other error. */
async function readUiVersionMismatch(
  res: Response,
): Promise<UiVersionMismatchBody | null> {
  if (res.status !== 409 && res.status !== 428) return null;
  try {
    const body = (await res.clone().json()) as UiVersionMismatchBody;
    return body.code === UI_VERSION_MISMATCH_CODE ? body : null;
  } catch {
    return null;
  }
}

/**
 * Single funnel for every frontend write.
 *
 * Checks the page version *before* sending (nothing is submitted from a stale
 * tab), stamps the UI version on the request, and turns the gateway's own
 * `ui-version-mismatch` rejection into the same "refresh first" outcome — the
 * server check is the authoritative one, this is the fast path.
 */
async function write<T>(
  path: string,
  init: { method: "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown },
): Promise<T> {
  const check = await checkUiVersionForWrite();
  if (!check.ok) {
    reportStaleWrite({
      clientVersion: check.clientVersion,
      serverVersion: check.serverVersion,
      source: "client",
    });
    throw new StaleUiVersionError(check.clientVersion, check.serverVersion);
  }

  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      // Only stamp content-type when there is a body: bodyless writes (e.g.
      // task stop / cancel) would otherwise hit Fastify's
      // FST_ERR_CTP_EMPTY_JSON_BODY → 400 "Bad Request".
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      [UI_VERSION_HEADER]: APP_VERSION,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const rejected = await readUiVersionMismatch(res);
  if (rejected) {
    const clientVersion = rejected.clientVersion?.trim() || APP_VERSION;
    const serverVersion = rejected.serverVersion?.trim() || null;
    reportStaleWrite({ clientVersion, serverVersion, source: "server" });
    throw new StaleUiVersionError(clientVersion, serverVersion);
  }

  return j<T>(res);
}

export const api = {
  getAuth: () => fetch(`${BASE}/auth`).then((r) => j<AuthStatus>(r)),

  listProviders: () =>
    fetch(`${BASE}/providers`).then((r) =>
      j<{ providers: ProviderInfo[]; defaultProvider: string }>(r),
    ),

  listModels: (provider?: string, accountId?: string) => {
    const params = new URLSearchParams();
    if (provider) params.set("provider", provider);
    if (accountId) params.set("accountId", accountId);
    const q = params.toString() ? `?${params.toString()}` : "";
    return fetch(`${BASE}/models${q}`).then((r) =>
      j<{
        provider: string;
        accountId?: string;
        vendor?: string;
        models: ModelInfo[];
        resolved?: string;
      }>(r),
    );
  },

  listAccounts: (filter?: { provider?: string; vendor?: string; enabled?: boolean }) => {
    const params = new URLSearchParams();
    if (filter?.provider) params.set("provider", filter.provider);
    if (filter?.vendor) params.set("vendor", filter.vendor);
    if (filter?.enabled !== undefined) params.set("enabled", filter.enabled ? "1" : "0");
    const q = params.toString() ? `?${params.toString()}` : "";
    return fetch(`${BASE}/accounts${q}`).then((r) =>
      j<{
        accounts: ProviderAccount[];
        vendors: { cursor: string[]; cline: string[] };
      }>(r),
    );
  },

  createAccount: (body: {
    provider: string;
    vendor?: string;
    label: string;
    apiKey: string;
    baseUrl?: string;
    agentRootWorkspace: string;
    enabled?: boolean;
    isDefault?: boolean;
  }) => write<ProviderAccount>("/accounts", { method: "POST", body }),

  updateAccount: (
    accountId: string,
    body: {
      provider?: string;
      vendor?: string;
      label?: string;
      apiKey?: string;
      baseUrl?: string;
      agentRootWorkspace?: string;
      enabled?: boolean;
      isDefault?: boolean;
    },
  ) =>
    write<ProviderAccount>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body,
    }),

  deleteAccount: (accountId: string) =>
    write<{ ok: true }>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    }),

  verifyAccount: (accountId: string) =>
    write<{
      accountId: string;
      provider: string;
      vendor: string;
      label: string;
      ok: boolean;
      detail: string;
    }>(`/accounts/${encodeURIComponent(accountId)}/verify`, { method: "POST" }),

  listProjects: () => fetch(`${BASE}/projects`).then((r) => j<Project[]>(r)),

  createProject: (
    name: string,
    options?: { department?: DepartmentConfig },
  ) => write<Project>("/projects", { method: "POST", body: { name, ...options } }),

  renameProject: (projectId: string, name: string) =>
    write<Project>(`/projects/${projectId}`, { method: "PATCH", body: { name } }),

  updateProject: (projectId: string, body: { name?: string }) =>
    write<Project>(`/projects/${projectId}`, { method: "PATCH", body }),

  // ---- 「交给 autonomy」入口（控制面只代理，不落库）-------------------------------
  // 数据源全是 autonomy；控制面只转发、不改写、不缓存业务状态。

  /** autonomy 可用性 / 版本 / LLM 后端 + 入口开关（不可达时 available:false，不是 500）。 */
  autonomyMeta: () =>
    fetch(`${BASE}/autonomy/meta`).then((r) => j<AutonomyMeta>(r)),

  /** autonomy 任务列表（可按当前 project 过滤）。 */
  autonomyTasks: (projectId?: string) => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return fetch(`${BASE}/autonomy/tasks${q}`).then((r) =>
      j<AutonomyTaskList>(r),
    );
  },

  /** autonomy 任务详情 / 进展（404 会抛出它的原文）。 */
  autonomyTask: (taskId: string) =>
    fetch(`${BASE}/autonomy/tasks/${encodeURIComponent(taskId)}`).then((r) =>
      j<AutonomyTaskDetail>(r),
    ),

  /**
   * autonomy 的账号池 —— 「交给 autonomy」时选账号的下拉（不可达时 `available:false`，不是 500）。
   * 注意：这是 **autonomy 的**池子（决定它那边用哪个 harness / vendor / model），
   * 与 `listAccounts`（控制面自己的池子，给本机 agent 用）不是一个。
   */
  autonomyAccounts: () =>
    fetch(`${BASE}/autonomy/accounts`).then((r) => j<AutonomyAccountList>(r)),

  /**
   * 执行方（autonomy）的状态 / 进展 —— 按**我们的** taskId 读（控制面代理）。
   * 只对 `agentPath=autonomy` 的任务有意义（没有交接记录 → 404）。
   */
  taskExecutor: (taskId: string) =>
    fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/executor`).then((r) =>
      j<AutonomyTaskDetail>(r),
    ),

  listTasks: (projectId?: string) => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return fetch(`${BASE}/tasks${q}`).then((r) => j<Task[]>(r));
  },

  createTask: (body: {
    title?: string;
    /** 任务描述（需求原文）——后端必填，缺了会 400。 */
    description: string;
    /** 任务类型标签（纯分类）；缺省 `general`。 */
    taskType?: TaskType;
    /** 交付目标（会改变 agent 的动作）；缺省后端用 `merge`。 */
    goal?: TaskGoal;
    workspace?: string;
    projectId?: string;
    provider?: string;
    model?: string;
    accountId?: string;
    vendor?: string;
    /**
     * agent 创建路径：`autonomy` = 任务仍由控制面创建，**执行**交给 autonomy
     * （agent 由它的 runtime 创建；交接失败时任务保留并标 error，错误原文在 4xx/503 里）。
     */
    agentPath?: "control-plane" | "autonomy";
    /**
     * **autonomy 的**账号池里的账号（只在 `agentPath=autonomy` 时有意义）：
     * 决定这条任务在它那边用哪个 harness / vendor / model / 工作目录。不传 = 由它的池子解析。
     */
    autonomyAccountId?: string;
  }) => write<Task>("/tasks", { method: "POST", body }),

  /**
   * 修改任务意图（标题 / 类型 / 目标 / 描述）。描述不允许改成空；
   * 目标传 `null` = 清掉目标（回到「开完 PR 即停」）。
   */
  updateTaskIntent: (
    taskId: string,
    body: {
      title?: string;
      description?: string;
      taskType?: TaskType;
      goal?: TaskGoal | null;
    },
  ) => write<Task>(`/tasks/${taskId}`, { method: "PATCH", body }),

  getTask: (id: string) => fetch(`${BASE}/tasks/${id}`).then((r) => j<TaskDetail>(r)),

  getTokenUsageSeries: (params: {
    projectId?: string;
    granularity?: UsageGranularity;
    timeZone?: UsageTimeZone;
    from?: string;
    to?: string;
  }) => {
    const q = new URLSearchParams();
    if (params.projectId) q.set("projectId", params.projectId);
    if (params.granularity) q.set("granularity", params.granularity);
    if (params.timeZone) q.set("timeZone", params.timeZone);
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    const s = q.toString();
    return fetch(`${BASE}/stats/token-usage${s ? `?${s}` : ""}`).then(
      (r) => j<TokenUsageSeries>(r),
    );
  },

  /** Agent 看板：所有 agent（含所属部门 / project / task / token / 时长）。 */
  getAgentBoard: (opts?: { scope?: AgentBoardScope; projectId?: string }) => {
    const q = new URLSearchParams();
    if (opts?.scope) q.set("scope", opts.scope);
    if (opts?.projectId) q.set("projectId", opts.projectId);
    const s = q.toString();
    return fetch(`${BASE}/agents${s ? `?${s}` : ""}`).then((r) =>
      j<AgentBoard>(r),
    );
  },

  /**
   * Agent 时间线：某段时间内这个 agent 的 idle / thinking / working 状态
   * （含用户的 input 事件）。`from`/`to` 为 ISO；缺省为最近 1 小时。
   */
  getAgentTimeline: (
    agentId: string,
    params?: { from?: string; to?: string; projectId?: string },
  ) => {
    const q = new URLSearchParams();
    if (params?.from) q.set("from", params.from);
    if (params?.to) q.set("to", params.to);
    if (params?.projectId) q.set("projectId", params.projectId);
    const s = q.toString();
    return fetch(
      `${BASE}/agents/${encodeURIComponent(agentId)}/timeline${s ? `?${s}` : ""}`,
    ).then((r) => j<AgentTimeline>(r));
  },

  getAgentRuntime: (params?: {
    windowMs?: number;
    from?: string;
    to?: string;
    all?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params?.all) q.set("all", "1");
    else if (params?.from && params?.to) {
      q.set("from", params.from);
      q.set("to", params.to);
    } else if (params?.windowMs != null) {
      q.set("windowMs", String(params.windowMs));
    }
    const s = q.toString();
    return fetch(`${BASE}/ops/agent-runtime${s ? `?${s}` : ""}`).then((r) =>
      j<AgentRuntimeStatus>(r),
    );
  },

  getEvents: (
    id: string,
    opts?: { after?: number; before?: number; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts?.after != null) params.set("after", String(opts.after));
    if (opts?.before != null) params.set("before", String(opts.before));
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    const q = params.toString();
    return fetch(`${BASE}/tasks/${id}/events${q ? `?${q}` : ""}`).then(
      (r) => j<{ events: AgentEvent[]; nextSeq: number; hasMore: boolean }>(r),
    );
  },

  /**
   * 给**对账行**（只在 autonomy 那边存在、我们没建过的任务）投递一条指令 —— 按它的 task id。
   * 与 `sendMessage` 对 `agentPath=autonomy` 的任务做的事完全一样，只是寻址不同。
   */
  sendMessageToExecutor: (
    executorTaskId: string,
    message: string,
    mode?: "chat" | "command",
  ) =>
    write<{
      executor?: boolean;
      executorTaskId?: string;
      executorAgentId?: number;
      executorStatus?: string;
      messageId?: number;
      queueAhead?: number;
      inputMode?: "chat" | "command";
    }>(`/autonomy/tasks/${executorTaskId}/messages`, {
      method: "POST",
      body: { message, ...(mode ? { mode } : {}) },
    }),

  sendMessage: (
    id: string,
    message: string,
    images?: Array<{
      data: string;
      mimeType: string;
      width?: number;
      height?: number;
    }>,
    mode?: "agent" | "plan" | "chat" | "command",
    planAnswerBatch?: import("./plan-questions").PlanAnswerBatch,
  ) =>
    write<{
      /** 本机 agent：这一轮 run 的 id（老行为）。 */
      runId?: string;
      queued?: boolean;
      queueLength?: number;
      /** `agentPath=autonomy`：这条消息**投递给执行方**了（本机没有 run）。 */
      executor?: boolean;
      executorTaskId?: string;
      executorAgentId?: number;
      executorStatus?: string;
      /** 投递回执：这条指令在它 inbox 里的 id。 */
      messageId?: number;
      /** 投递回执：它前面还有几条（= autonomy 的 `queued`，数字）。 */
      queueAhead?: number;
      /** `agentPath=autonomy`：这次投递用的 chat / command。 */
      inputMode?: "chat" | "command";
    }>(
      `/tasks/${id}/messages`,
      {
        method: "POST",
        body: {
          message,
          ...(images?.length ? { images } : {}),
          ...(mode ? { mode } : {}),
          ...(planAnswerBatch ? { planAnswerBatch } : {}),
        },
      },
    ),

  listAgentSuccessions: (taskId: string) =>
    fetch(`${BASE}/tasks/${taskId}/agent-successions`).then((r) =>
      j<{ successions: import("./types").AgentSuccession[] }>(r),
    ),

  /** 上下文将满时把 task 分流成新 task（继承工作区/模型/PR，带最近历史）。 */
  forkTask: (id: string, title?: string) =>
    write<{ task: import("./types").Task; source: import("./types").Task }>(
      `/tasks/${id}/fork`,
      { method: "POST", body: { ...(title?.trim() ? { title } : {}) } },
    ),

  stopTask: (id: string) =>
    write<{ runId: string; stopped: boolean }>(`/tasks/${id}/stop`, {
      method: "POST",
    }),

  cancelQueuedRun: (taskId: string, runId: string) =>
    write<{ runId: string; queueLength: number; cancelled: boolean }>(
      `/tasks/${taskId}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    ),

  getGlobalSettings: () =>
    fetch(`${BASE}/settings/global`).then((r) => j<AppSettings>(r)),

  updateGlobalSettings: (body: AppSettings) =>
    write<AppSettings>("/settings/global", { method: "PATCH", body }),

  getProjectSettings: (projectId: string) =>
    fetch(`${BASE}/projects/${projectId}/settings`).then((r) =>
      j<ProjectSettingsView>(r),
    ),

  updateProjectSettings: (projectId: string, body: AppSettings) =>
    write<ProjectSettingsView>(`/projects/${projectId}/settings`, {
      method: "PATCH",
      body,
    }),

  /**
   * Department catalogue for project settings. Sourced from the organization
   * service; `available: false` + `error` means it could not be reached (the
   * settings page then keeps the stored value instead of failing).
   */
  listDepartments: (opts?: { refresh?: boolean }) =>
    fetch(`${BASE}/org/departments${opts?.refresh ? "?refresh=1" : ""}`).then((r) =>
      j<DepartmentList>(r),
    ),
};

export type { TokenUsage };
