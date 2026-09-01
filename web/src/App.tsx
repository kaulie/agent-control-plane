import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectWs, type ServerMessage } from "./ws";
import type { AgentEvent, AuthStatus, Project, Task, TaskDetail } from "./types";
import TaskList from "./components/TaskList";
import UsageBar from "./components/UsageBar";
import Timeline from "./components/Timeline";
import ChatInput from "./components/ChatInput";

const PROJECT_STORAGE_KEY = "web-cursor:selectedProjectId";
const DEFAULT_PROJECT_ID = "project-default";

function loadStoredProjectId(): string | null {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeProjectId(id: string): void {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => loadStoredProjectId(),
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const selectedProjectRef = useRef(selectedProjectId);
  selectedProjectRef.current = selectedProjectId;
  const lastSeqRef = useRef(0);

  const refreshProjects = useCallback(async (): Promise<Project[]> => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, []);

  const refreshTasks = useCallback(async (projectId?: string | null) => {
    const pid = projectId ?? selectedProjectRef.current;
    if (!pid) {
      setTasks([]);
      return;
    }
    try {
      setTasks(await api.listTasks(pid));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await api.getTask(id);
      setDetail(d);
      setRunning(d.runs.some((r) => r.status === "running"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setEvents([]);
    setRunning(false);
    setStopping(false);
    setHasMore(false);
    setLoadingMore(false);
    lastSeqRef.current = 0;
  }, []);

  const selectProject = useCallback(
    async (id: string) => {
      setSelectedProjectId(id);
      storeProjectId(id);
      clearSelection();
      await refreshTasks(id);
    },
    [clearSelection, refreshTasks],
  );

  useEffect(() => {
    api
      .getAuth()
      .then(setAuth)
      .catch(() => setAuth({ ok: false, detail: "unreachable" }));

    void (async () => {
      try {
        const list = await refreshProjects();
        const stored = loadStoredProjectId();
        const resolved =
          (stored && list.some((p) => p.projectId === stored) && stored) ||
          list.find((p) => p.projectId === DEFAULT_PROJECT_ID)?.projectId ||
          list[0]?.projectId ||
          null;
        if (resolved) {
          setSelectedProjectId(resolved);
          storeProjectId(resolved);
          await refreshTasks(resolved);
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [refreshProjects, refreshTasks]);

  useEffect(() => {
    const close = connectWs(
      (msg: ServerMessage) => {
        if (msg.type === "agent_event") {
          const ev = msg.event as AgentEvent;
          if (ev.taskId === selectedRef.current) {
            setEvents((prev) =>
              prev.some((p) => p.eventId === ev.eventId)
                ? prev
                : [...prev, ev],
            );
            if (
              ev.eventType === "run_completed" ||
              ev.eventType === "run_error" ||
              ev.eventType === "run_cancelled"
            ) {
              setRunning(false);
              setStopping(false);
              void refreshDetail(ev.taskId);
            }
          }
        } else if (msg.type === "task_updated") {
          const tid = (msg.task as Task | undefined)?.taskId;
          if (tid && tid === selectedRef.current) {
            void refreshDetail(tid);
          }
          void refreshTasks();
        } else if (msg.type === "task_created") {
          void refreshTasks();
        } else if (
          msg.type === "project_created" ||
          msg.type === "project_updated"
        ) {
          void refreshProjects();
        }
      },
      setWsStatus,
    );
    return close;
  }, [refreshDetail, refreshTasks, refreshProjects]);

  // Poll while a run is active so the timeline and stats stay fresh even if
  // the WebSocket drops (belt-and-suspenders alongside the live push).
  useEffect(() => {
    if (!selectedId || !running) return;
    const id = window.setInterval(async () => {
      try {
        const [evRes, detailRes] = await Promise.all([
          api.getEvents(selectedId, { after: lastSeqRef.current }),
          api.getTask(selectedId),
        ]);
        setEvents((prev) => {
          const ids = new Set(prev.map((p) => p.eventId));
          const fresh = evRes.events.filter((e) => !ids.has(e.eventId));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        lastSeqRef.current = evRes.nextSeq;
        setDetail(detailRes);
        const stillRunning = detailRes.runs.some((r) => r.status === "running");
        setRunning(stillRunning);
        if (!stillRunning) setStopping(false);
      } catch {
        /* transient — ignore */
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [selectedId, running]);

  const selectTask = useCallback(async (id: string) => {
    setSelectedId(id);
    setEvents([]);
    setDetail(null);
    setStopping(false);
    try {
      const d = await api.getTask(id);
      setDetail(d);
      setRunning(d.runs.some((r) => r.status === "running"));
    } catch (e) {
      setError(String(e));
    }
    try {
      const r = await api.getEvents(id);
      setEvents(r.events);
      lastSeqRef.current = r.nextSeq;
      setHasMore(r.hasMore);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const createTask = useCallback(async () => {
    if (!selectedProjectId) return;
    const title = window.prompt("Task title (optional):") || undefined;
    try {
      const task = await api.createTask({
        title,
        projectId: selectedProjectId,
      });
      await refreshTasks(selectedProjectId);
      await selectTask(task.taskId);
    } catch (e) {
      setError(String(e));
    }
  }, [refreshTasks, selectTask, selectedProjectId]);

  const createProject = useCallback(async () => {
    const name = window.prompt("Project name:");
    if (!name?.trim()) return;
    try {
      const project = await api.createProject(name.trim());
      await refreshProjects();
      await selectProject(project.projectId);
    } catch (e) {
      setError(String(e));
    }
  }, [refreshProjects, selectProject]);

  const renameProject = useCallback(async () => {
    if (!selectedProjectId) return;
    const current = projects.find((p) => p.projectId === selectedProjectId);
    const name = window.prompt("Rename project:", current?.name ?? "");
    if (!name?.trim()) return;
    try {
      await api.renameProject(selectedProjectId, name.trim());
      await refreshProjects();
    } catch (e) {
      setError(String(e));
    }
  }, [projects, refreshProjects, selectedProjectId]);

  const sendMessage = useCallback(
    async (payload: { text: string; images: Array<{ data: string; mimeType: string; width?: number; height?: number }> }) => {
      if (!selectedId) return;
      if (!payload.text.trim() && payload.images.length === 0) return;
      setError(null);
      setRunning(true);
      setStopping(false);
      try {
        await api.sendMessage(
          selectedId,
          payload.text,
          payload.images.map(({ data, mimeType, width, height }) => ({
            data,
            mimeType,
            width,
            height,
          })),
        );
      } catch (e) {
        setError(String(e));
        setRunning(false);
      }
    },
    [selectedId],
  );

  const stopAgent = useCallback(async () => {
    if (!selectedId || !running || stopping) return;
    setStopping(true);
    setError(null);
    try {
      await api.stopTask(selectedId);
    } catch (e) {
      setError(String(e));
      setStopping(false);
    }
  }, [selectedId, running, stopping]);

  const loadMore = useCallback(async () => {
    if (!selectedId || loadingMore || !hasMore) return;
    const oldest = events[0]?.seq;
    if (oldest == null) return;
    setLoadingMore(true);
    try {
      const r = await api.getEvents(selectedId, { before: oldest, limit: 100 });
      setEvents((prev) => {
        const ids = new Set(prev.map((p) => p.eventId));
        const fresh = r.events.filter((e) => !ids.has(e.eventId));
        return [...fresh, ...prev];
      });
      setHasMore(r.hasMore);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [selectedId, loadingMore, hasMore, events]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">Web Cursor</div>
        <div className="status">
          <span className={`dot ${auth?.ok ? "ok" : "bad"}`} />
          {auth?.ok ? auth.detail : "auth: not configured"}
          <span className="sep">·</span>
          <span className={`dot ${wsStatus === "connected" ? "ok" : "bad"}`} />
          ws: {wsStatus}
        </div>
      </header>
      <div className="body">
        <TaskList
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(id) => void selectProject(id)}
          onCreateProject={() => void createProject()}
          onRenameProject={() => void renameProject()}
          tasks={tasks}
          selectedId={selectedId}
          onSelect={selectTask}
          onCreate={createTask}
        />
        <main className="main">
          {selectedId && detail ? (
            <>
              <UsageBar task={detail.task} stats={detail.stats} />
              <Timeline
                events={events}
                running={running}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={() => void loadMore()}
              />
              <ChatInput
                onSend={sendMessage}
                onStop={() => void stopAgent()}
                disabled={running}
                running={running}
                stopping={stopping}
              />
            </>
          ) : (
            <div className="empty">
              {selectedProjectId
                ? "Select or create a task to begin"
                : "Select or create a project to begin"}
            </div>
          )}
        </main>
      </div>
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error} ✕
        </div>
      )}
    </div>
  );
}
