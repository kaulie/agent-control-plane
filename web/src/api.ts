import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  Project,
  ProjectSettingsView,
  Task,
  TaskDetail,
  TokenUsage,
} from "./types";
import { checkServerVersion } from "./version-check";

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

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  checkServerVersion(res.headers.get("X-App-Version"));
  return res;
}

export const api = {
  getAuth: () => apiFetch(`${BASE}/auth`).then((r) => j<AuthStatus>(r)),

  listProjects: () => apiFetch(`${BASE}/projects`).then((r) => j<Project[]>(r)),

  createProject: (name: string, workspaceRoot?: string) =>
    apiFetch(`${BASE}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...(workspaceRoot ? { workspaceRoot } : {}) }),
    }).then((r) => j<Project>(r)),

  renameProject: (projectId: string, name: string) =>
    apiFetch(`${BASE}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => j<Project>(r)),

  updateProject: (
    projectId: string,
    body: { name?: string; workspaceRoot?: string | null },
  ) =>
    apiFetch(`${BASE}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<Project>(r)),

  listTasks: (projectId?: string) => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return apiFetch(`${BASE}/tasks${q}`).then((r) => j<Task[]>(r));
  },

  createTask: (body: { title?: string; workspace?: string; projectId?: string }) =>
    apiFetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<Task>(r)),

  getTask: (id: string) => apiFetch(`${BASE}/tasks/${id}`).then((r) => j<TaskDetail>(r)),

  getEvents: (
    id: string,
    opts?: { after?: number; before?: number; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (opts?.after != null) params.set("after", String(opts.after));
    if (opts?.before != null) params.set("before", String(opts.before));
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    const q = params.toString();
    return apiFetch(`${BASE}/tasks/${id}/events${q ? `?${q}` : ""}`).then(
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
    apiFetch(`${BASE}/tasks/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        ...(images?.length ? { images } : {}),
        ...(mode ? { mode } : {}),
        ...(planAnswerBatch ? { planAnswerBatch } : {}),
      }),
    }).then((r) => j<{ runId: string; queued?: boolean; queueLength?: number }>(r)),

  transitionWorkflow: (id: string, toState: string) =>
    apiFetch(`${BASE}/tasks/${id}/workflow/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toState }),
    }).then((r) =>
      j<{ task: Task; workflow: import("./workflows").TaskWorkflowView }>(r),
    ),

  stopTask: (id: string) =>
    apiFetch(`${BASE}/tasks/${id}/stop`, {
      method: "POST",
    }).then((r) => j<{ runId: string; stopped: boolean }>(r)),

  getGlobalSettings: () =>
    apiFetch(`${BASE}/settings/global`).then((r) => j<AppSettings>(r)),

  updateGlobalSettings: (body: AppSettings) =>
    apiFetch(`${BASE}/settings/global`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<AppSettings>(r)),

  getProjectSettings: (projectId: string) =>
    apiFetch(`${BASE}/projects/${projectId}/settings`).then((r) =>
      j<ProjectSettingsView>(r),
    ),

  updateProjectSettings: (projectId: string, body: AppSettings) =>
    apiFetch(`${BASE}/projects/${projectId}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<ProjectSettingsView>(r)),
};

export type { TokenUsage };
