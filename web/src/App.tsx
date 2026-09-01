import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { connectWs, type ServerMessage } from "./ws";
import type { AgentEvent, AuthStatus, Task, TaskDetail } from "./types";
import TaskList from "./components/TaskList";
import UsageBar from "./components/UsageBar";
import Timeline from "./components/Timeline";
import ChatInput from "./components/ChatInput";

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
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

  useEffect(() => {
    api
      .getAuth()
      .then(setAuth)
      .catch(() => setAuth({ ok: false, detail: "unreachable" }));
    void refreshTasks();
  }, [refreshTasks]);

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
              ev.eventType === "run_error"
            ) {
              setRunning(false);
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
        }
      },
      setWsStatus,
    );
    return close;
  }, [refreshDetail, refreshTasks]);

  // Poll while a run is active so the timeline and stats stay fresh even if
  // the WebSocket drops (belt-and-suspenders alongside the live push).
  useEffect(() => {
    if (!selectedId || !running) return;
    const id = window.setInterval(async () => {
      try {
        const [evRes, detailRes] = await Promise.all([
          api.getEvents(selectedId),
          api.getTask(selectedId),
        ]);
        setEvents((prev) => {
          const ids = new Set(prev.map((p) => p.eventId));
          const fresh = evRes.events.filter((e) => !ids.has(e.eventId));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        setDetail(detailRes);
        setRunning(detailRes.runs.some((r) => r.status === "running"));
      } catch {
        /* transient — ignore */
      }
    }, 3500);
    return () => window.clearInterval(id);
  }, [selectedId, running]);

  const selectTask = useCallback(async (id: string) => {
    setSelectedId(id);
    setEvents([]);
    setDetail(null);
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
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const createTask = useCallback(async () => {
    const title = window.prompt("Task title (optional):") || undefined;
    try {
      const task = await api.createTask({ title });
      await refreshTasks();
      await selectTask(task.taskId);
    } catch (e) {
      setError(String(e));
    }
  }, [refreshTasks, selectTask]);

  const sendMessage = useCallback(
    async (message: string) => {
      if (!selectedId || !message.trim()) return;
      setError(null);
      setRunning(true);
      try {
        await api.sendMessage(selectedId, message);
      } catch (e) {
        setError(String(e));
        setRunning(false);
      }
    },
    [selectedId],
  );

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
          tasks={tasks}
          selectedId={selectedId}
          onSelect={selectTask}
          onCreate={createTask}
        />
        <main className="main">
          {selectedId && detail ? (
            <>
              <UsageBar task={detail.task} stats={detail.stats} />
              <Timeline events={events} running={running} />
              <ChatInput onSend={sendMessage} disabled={running} />
            </>
          ) : (
            <div className="empty">Select or create a task to begin</div>
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
