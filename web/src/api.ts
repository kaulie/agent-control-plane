import type {
  AgentEvent,
  AuthStatus,
  Project,
  Task,
  TaskDetail,
  TokenUsage,
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

  listProjects: () => fetch(`${BASE}/projects`).then((r) => j<Project[]>(r)),

  createProject: (name: string, workspaceRoot?: string) =>
    fetch(`${BASE}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...(workspaceRoot ? { workspaceRoot } : {}) }),
    }).then((r) => j<Project>(r)),

  renameProject: (projectId: string, name: string) =>
    fetch(`${BASE}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => j<Project>(r)),

  updateProject: (
    projectId: string,
    body: { name?: string; workspaceRoot?: string | null },
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

  createTask: (body: { title?: string; workspace?: string; projectId?: string }) =>
    fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<Task>(r)),

  getTask: (id: string) => fetch(`${BASE}/tasks/${id}`).then((r) => j<TaskDetail>(r)),

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
  ) =>
    fetch(`${BASE}/tasks/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        ...(images?.length ? { images } : {}),
        ...(mode ? { mode } : {}),
      }),
    }).then((r) => j<{ runId: string; queued?: boolean; queueLength?: number }>(r)),

  stopTask: (id: string) =>
    fetch(`${BASE}/tasks/${id}/stop`, {
      method: "POST",
    }).then((r) => j<{ runId: string; stopped: boolean }>(r)),
};

export type { TokenUsage };
