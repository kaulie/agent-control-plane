import type {
  AgentBoard,
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
      "content-type": "application/json",
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

  listModels: (provider?: string) => {
    const q = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    return fetch(`${BASE}/models${q}`).then((r) =>
      j<{ provider: string; models: ModelInfo[]; resolved?: string }>(r),
    );
  },

  listProjects: () => fetch(`${BASE}/projects`).then((r) => j<Project[]>(r)),

  createProject: (
    name: string,
    options?: { gitRepoUrl?: string; department?: DepartmentConfig },
  ) => write<Project>("/projects", { method: "POST", body: { name, ...options } }),

  renameProject: (projectId: string, name: string) =>
    write<Project>(`/projects/${projectId}`, { method: "PATCH", body: { name } }),

  updateProject: (
    projectId: string,
    body: {
      name?: string;
      gitRepoUrl?: string | null;
    },
  ) => write<Project>(`/projects/${projectId}`, { method: "PATCH", body }),

  listTasks: (projectId?: string) => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return fetch(`${BASE}/tasks${q}`).then((r) => j<Task[]>(r));
  },

  createTask: (body: {
    title?: string;
    workspace?: string;
    projectId?: string;
    provider?: string;
    model?: string;
  }) => write<Task>("/tasks", { method: "POST", body }),

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

  sendMessage: (
    id: string,
    message: string,
    images?: Array<{
      data: string;
      mimeType: string;
      width?: number;
      height?: number;
    }>,
    mode?: "agent" | "plan",
    planAnswerBatch?: import("./plan-questions").PlanAnswerBatch,
  ) =>
    write<{ runId: string; queued?: boolean; queueLength?: number }>(
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
