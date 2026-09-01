import type {
  AgentEvent,
  AuthStatus,
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

  listTasks: () => fetch(`${BASE}/tasks`).then((r) => j<Task[]>(r)),

  createTask: (body: { title?: string; workspace?: string }) =>
    fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<Task>(r)),

  getTask: (id: string) => fetch(`${BASE}/tasks/${id}`).then((r) => j<TaskDetail>(r)),

  getEvents: (id: string) =>
    fetch(`${BASE}/tasks/${id}/events`).then((r) => j<{ events: AgentEvent[] }>(r)),

  sendMessage: (id: string, message: string) =>
    fetch(`${BASE}/tasks/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) => j<{ runId: string }>(r)),
};

export type { TokenUsage };
