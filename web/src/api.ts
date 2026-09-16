import type {
  AgentEvent,
  AgentRuntimeStatus,
  AppSettings,
  AuthStatus,
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
    options?: { gitRepoUrl?: string },
  ) =>
    fetch(`${BASE}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...options }),
    }).then((r) => j<Project>(r)),

  renameProject: (projectId: string, name: string) =>
    fetch(`${BASE}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => j<Project>(r)),

  updateProject: (
    projectId: string,
    body: {
      name?: string;
      gitRepoUrl?: string | null;
    },
  ) =>
    fetch(`${BASE}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<Project>(r)),

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
  }) =>
    fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<Task>(r)),

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
    fetch(`${BASE}/tasks/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        ...(images?.length ? { images } : {}),
        ...(mode ? { mode } : {}),
        ...(planAnswerBatch ? { planAnswerBatch } : {}),
      }),
    }).then((r) => j<{ runId: string; queued?: boolean; queueLength?: number }>(r)),

  listAgentSuccessions: (taskId: string) =>
    fetch(`${BASE}/tasks/${taskId}/agent-successions`).then((r) =>
      j<{ successions: import("./types").AgentSuccession[] }>(r),
    ),

  stopTask: (id: string) =>
    fetch(`${BASE}/tasks/${id}/stop`, {
      method: "POST",
    }).then((r) => j<{ runId: string; stopped: boolean }>(r)),

  cancelQueuedRun: (taskId: string, runId: string) =>
    fetch(
      `${BASE}/tasks/${taskId}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    ).then((r) =>
      j<{ runId: string; queueLength: number; cancelled: boolean }>(r),
    ),

  getGlobalSettings: () =>
    fetch(`${BASE}/settings/global`).then((r) => j<AppSettings>(r)),

  updateGlobalSettings: (body: AppSettings) =>
    fetch(`${BASE}/settings/global`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<AppSettings>(r)),

  getProjectSettings: (projectId: string) =>
    fetch(`${BASE}/projects/${projectId}/settings`).then((r) =>
      j<ProjectSettingsView>(r),
    ),

  updateProjectSettings: (projectId: string, body: AppSettings) =>
    fetch(`${BASE}/projects/${projectId}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<ProjectSettingsView>(r)),
};

export type { TokenUsage };
