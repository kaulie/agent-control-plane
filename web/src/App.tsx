import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { connectWs, type ServerMessage } from "./ws";
import type { AgentEvent, AppView, AuthStatus, Project, Task, TaskDetail } from "./types";
import TaskList from "./components/TaskList";
import UsageBar from "./components/UsageBar";
import UsageStatsPage from "./components/UsageStatsPage";
import { AgentRuntimePage } from "./components/AgentRuntimePage";
import CreateTaskDialog from "./components/CreateTaskDialog";
import Timeline from "./components/Timeline";
import PlanDocumentPanel from "./components/PlanDocumentPanel";
import ChatInput, { type AgentMode } from "./components/ChatInput";
import GlobalSettingsPage from "./components/GlobalSettingsPage";
import ProjectSettingsPage from "./components/ProjectSettingsPage";
import PlanQuestionsWizard from "./components/PlanQuestionsWizard";
import {
  findPendingPlanQuestionBatch,
  type PlanAnswerBatch,
} from "./plan-questions";
import { APP_VERSION } from "./version";
import {
  beginUpgrade,
  dismissVersionUpdate,
  pollHealthVersion,
  subscribeVersionUpdate,
  type VersionUpdate,
} from "./version-check";

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


/** Merge + sort by seq so incremental polls never scramble the timeline. */
function mergeEventsBySeq(prev: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (incoming.length === 0) return prev;
  const byId = new Map<string, AgentEvent>();
  for (const e of prev) byId.set(e.eventId, e);
  for (const e of incoming) byId.set(e.eventId, e);
  return [...byId.values()].sort((a, b) => {
    const sa = a.seq;
    const sb = b.seq;
    // Missing seq must NOT collapse to 0 — that pinned live WS events above history.
    if (sa != null && sb != null && sa !== sb) return sa - sb;
    return a.timestamp.localeCompare(b.timestamp);
  });
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
  const [queueLength, setQueueLength] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [cancellingQueuedRunId, setCancellingQueuedRunId] = useState<
    string | null
  >(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [interruptNotice, setInterruptNotice] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("chat");
  const [mainTab, setMainTab] = useState<"timeline" | "plan">("timeline");
  const [selectedPlanRunId, setSelectedPlanRunId] = useState<string | null>(null);
  const [versionUpdate, setVersionUpdate] = useState<VersionUpdate | null>(null);
  const [upgradingVersion, setUpgradingVersion] = useState<string | null>(null);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [createTaskDefaults, setCreateTaskDefaults] = useState<{
    provider?: string;
    model?: string;
  }>({});

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const selectedProjectRef = useRef(selectedProjectId);
  selectedProjectRef.current = selectedProjectId;
  /** null = initial page not loaded yet; never poll with after=0 (that pulls full history). */
  const lastSeqRef = useRef<number | null>(null);
  const pollFailRef = useRef(0);
  const wasUnreachableRef = useRef(false);
  const [gracePolls, setGracePolls] = useState(0);
  const [needsResync, setNeedsResync] = useState(false);

  const applyQueueLength = useCallback((detailRes: TaskDetail | null): void => {
    if (!detailRes) {
      setQueueLength(0);
      return;
    }
    setQueueLength(
      detailRes.runs.filter((r) => r.status === "queued").length,
    );
  }, []);

  const applyRunState = useCallback((detailRes: TaskDetail | null): void => {
    if (!detailRes) {
      setRunning(false);
      setQueueLength(0);
      return;
    }
    setRunning(detailRes.runs.some((r) => r.status === "running"));
    applyQueueLength(detailRes);
  }, [applyQueueLength]);

  const applyInterruptNotice = useCallback((list: AgentEvent[]): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const ev = list[i];
      if (
        ev.eventType === "run_cancelled" &&
        ev.payload?.reason === "server_restart"
      ) {
        setInterruptNotice(
          String(
            ev.payload.message ??
              "任务因服务重启中断。状态已同步为结束，可继续发消息接着做。",
          ),
        );
        return;
      }
      if (
        ev.eventType === "run_completed" ||
        ev.eventType === "run_error" ||
        ev.eventType === "run_cancelled" ||
        ev.eventType === "user_message"
      ) {
        return;
      }
    }
  }, []);

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

  /** Full task+events pull — used after backend/WS recovery. */
  const resyncSelectedTask = useCallback(
    async (taskId: string): Promise<void> => {
      const [latest, detailRes] = await Promise.all([
        api.getEvents(taskId, { limit: 100 }),
        api.getTask(taskId),
      ]);
      lastSeqRef.current = latest.nextSeq;
      setHasMore(latest.hasMore);
      setEvents((prev) => mergeEventsBySeq(prev, latest.events));
      applyInterruptNotice(latest.events);
      setDetail(detailRes);
      applyRunState(detailRes);
      if (!detailRes.runs.some((r) => r.status === "running")) setStopping(false);
      void refreshTasks();
    },
    [applyInterruptNotice, applyRunState, refreshTasks],
  );

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await api.getTask(id);
      setDetail(d);
      applyRunState(d);
    } catch (e) {
      setError(String(e));
    }
  }, [applyRunState]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setEvents([]);
    setRunning(false);
    setQueueLength(0);
    setStopping(false);
    setCancellingQueuedRunId(null);
    setHasMore(false);
    setLoadingMore(false);
    setInterruptNotice(null);
    setMainTab("timeline");
    setSelectedPlanRunId(null);
    setGracePolls(0);
    setNeedsResync(false);
    wasUnreachableRef.current = false;
    lastSeqRef.current = null;
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

  useEffect(() => subscribeVersionUpdate(setVersionUpdate), []);

  // Poll /health for version drift (covers idle tabs between API calls).
  useEffect(() => {
    void pollHealthVersion();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void pollHealthVersion();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(() => void pollHealthVersion(), 30 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const close = connectWs(
      (msg: ServerMessage) => {
        if (msg.type === "agent_event") {
          const ev = msg.event as AgentEvent;
          if (ev.taskId === selectedRef.current) {
            if (typeof ev.seq === "number" && ev.seq > (lastSeqRef.current ?? 0)) {
              lastSeqRef.current = ev.seq;
            }
            setEvents((prev) =>
              prev.some((p) => p.eventId === ev.eventId)
                ? prev
                : mergeEventsBySeq(prev, [ev]),
            );
            if (
              ev.eventType === "run_completed" ||
              ev.eventType === "run_error" ||
              ev.eventType === "run_cancelled"
            ) {
              setStopping(false);
              void refreshDetail(ev.taskId);
              if (
                ev.eventType === "run_cancelled" &&
                ev.payload?.reason === "server_restart"
              ) {
                setInterruptNotice(
                  String(
                    ev.payload.message ??
                      "任务因服务重启中断。状态已同步为结束，可继续发消息接着做。",
                  ),
                );
              }
            }
            if (ev.eventType === "plan_exported") {
              setSelectedPlanRunId(ev.runId);
              setMainTab("plan");
            }
          }
        } else if (msg.type === "task_queue_updated") {
          const tid = typeof msg.taskId === "string" ? msg.taskId : "";
          if (tid && tid === selectedRef.current) {
            setQueueLength(
              typeof msg.queueLength === "number" ? msg.queueLength : 0,
            );
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

  // Mark outage so recovery can force a full sync once WS/backend return.
  useEffect(() => {
    if (backendDown || wsStatus !== "connected") {
      wasUnreachableRef.current = true;
      setNeedsResync(true);
    }
  }, [backendDown, wsStatus]);

  // After recovery: pull task + events once (does not depend on running).
  useEffect(() => {
    if (!selectedId || !needsResync) return;
    if (wsStatus !== "connected") return;

    let cancelled = false;
    void (async () => {
      try {
        await resyncSelectedTask(selectedId);
        if (cancelled) return;
        wasUnreachableRef.current = false;
        setNeedsResync(false);
        setBackendDown(false);
        pollFailRef.current = 0;
        setGracePolls(2);
      } catch {
        if (cancelled) return;
        wasUnreachableRef.current = true;
        setBackendDown(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, needsResync, wsStatus, resyncSelectedTask]);

  // Poll while a run is active, while unreachable, or for a few grace ticks.
  useEffect(() => {
    if (!selectedId) return;
    const unreachable = backendDown || wsStatus !== "connected";
    const shouldPoll = running || unreachable || gracePolls > 0 || needsResync;
    if (!shouldPoll) return;

    const intervalMs = unreachable || needsResync ? 2000 : 3000;

    const tick = async (): Promise<void> => {
      try {
        if (wasUnreachableRef.current || needsResync) {
          await resyncSelectedTask(selectedId);
          wasUnreachableRef.current = false;
          setNeedsResync(false);
          setBackendDown(false);
          pollFailRef.current = 0;
          setGracePolls(2);
          return;
        }

        const after = lastSeqRef.current;
        if (after == null) {
          // Initial selectTask load still in flight — avoid after=0 full-history pull.
          return;
        }

        const [evRes, detailRes] = await Promise.all([
          api.getEvents(selectedId, { after }),
          api.getTask(selectedId),
        ]);

        pollFailRef.current = 0;
        setBackendDown(false);

        setEvents((prev) => {
          const ids = new Set(prev.map((p) => p.eventId));
          const fresh = evRes.events.filter((e) => !ids.has(e.eventId));
          if (fresh.length) applyInterruptNotice(fresh);
          return fresh.length ? mergeEventsBySeq(prev, fresh) : prev;
        });
        lastSeqRef.current = evRes.nextSeq;
        setGracePolls((n) => (n > 0 ? n - 1 : 0));

        setDetail(detailRes);
        applyRunState(detailRes);
        if (!detailRes.runs.some((r) => r.status === "running")) setStopping(false);
      } catch {
        pollFailRef.current += 1;
        wasUnreachableRef.current = true;
        setNeedsResync(true);
        if (pollFailRef.current >= 1) setBackendDown(true);
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    return () => window.clearInterval(id);
  }, [
    selectedId,
    running,
    backendDown,
    wsStatus,
    gracePolls,
    needsResync,
    resyncSelectedTask,
    applyInterruptNotice,
    applyRunState,
  ]);

  const selectTask = useCallback(async (id: string) => {
    setSelectedId(id);
    setEvents([]);
    setDetail(null);
    setStopping(false);
    setInterruptNotice(null);
    setGracePolls(0);
    lastSeqRef.current = null;
    // Keep needsResync if we are mid-outage; otherwise a fresh select is enough.
    if (wasUnreachableRef.current) {
      setNeedsResync(true);
    } else {
      setNeedsResync(false);
    }
    try {
      const d = await api.getTask(id);
      setDetail(d);
      applyRunState(d);
    } catch (e) {
      setError(String(e));
      setNeedsResync(true);
    }
    try {
      const r = await api.getEvents(id);
      setEvents(r.events);
      lastSeqRef.current = r.nextSeq;
      setHasMore(r.hasMore);
      applyInterruptNotice(r.events);
    } catch (e) {
      setError(String(e));
      setNeedsResync(true);
    }
  }, [applyInterruptNotice, applyRunState]);

  const openCreateTask = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const settings = await api.getProjectSettings(selectedProjectId);
      setCreateTaskDefaults({
        provider: settings.effective.runtime?.defaultProvider,
        model: settings.effective.runtime?.defaultModel,
      });
    } catch {
      setCreateTaskDefaults({});
    }
    setShowCreateTask(true);
  }, [selectedProjectId]);

  const createTask = useCallback(
    async (input: { title?: string; provider?: string; model?: string }) => {
      if (!selectedProjectId) return;
      const task = await api.createTask({
        title: input.title,
        projectId: selectedProjectId,
        provider: input.provider,
        model: input.model,
      });
      await refreshTasks(selectedProjectId);
      await selectTask(task.taskId);
    },
    [refreshTasks, selectTask, selectedProjectId],
  );

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

  const setProjectGitRepoUrl = useCallback(async () => {
    if (!selectedProjectId) return;
    const current = projects.find((p) => p.projectId === selectedProjectId);
    const hint =
      "项目 Git 仓库地址（https / ssh / 本地路径）。\nAgent 将按 BRANCHING 规范从此地址 clone/push。\n留空则清除配置。";
    const value = window.prompt(hint, current?.gitRepoUrl ?? "");
    if (value === null) return;
    try {
      await api.updateProject(selectedProjectId, {
        gitRepoUrl: value.trim() || null,
      });
      await refreshProjects();
    } catch (e) {
      setError(String(e));
    }
  }, [projects, refreshProjects, selectedProjectId]);

  /** Pull events/detail after send so the user message is visible even if WS is quiet. */
  const refreshAfterSend = useCallback(
    async (taskId: string): Promise<void> => {
      try {
        const after = lastSeqRef.current;
        const [evRes, detailRes] = await Promise.all([
          after != null
            ? api.getEvents(taskId, { after })
            : api.getEvents(taskId, { limit: 100 }),
          api.getTask(taskId),
        ]);
        setEvents((prev) => mergeEventsBySeq(prev, evRes.events));
        lastSeqRef.current = evRes.nextSeq;
        setDetail(detailRes);
        applyRunState(detailRes);
        if (!detailRes.runs.some((r) => r.status === "running")) {
          setStopping(false);
        }
        setGracePolls((n) => Math.max(n, 2));
      } catch {
        setGracePolls(2);
        void refreshDetail(taskId);
      }
    },
    [applyRunState, refreshDetail],
  );

  const sendMessage = useCallback(
    async (payload: {
      text: string;
      images: Array<{ data: string; mimeType: string; width?: number; height?: number }>;
      mode: "agent" | "plan";
    }): Promise<boolean> => {
      if (!selectedId) return false;
      if (!payload.text.trim() && payload.images.length === 0) return false;
      setError(null);
      setInterruptNotice(null);
      setStopping(false);
      try {
        const res = await api.sendMessage(
          selectedId,
          payload.text,
          payload.images.map(({ data, mimeType, width, height }) => ({
            data,
            mimeType,
            width,
            height,
          })),
          payload.mode,
        );
        if (res.queued) {
          if (typeof res.queueLength === "number") {
            setQueueLength(res.queueLength);
          } else {
            setQueueLength((n) => n + 1);
          }
        } else {
          setRunning(true);
        }
        if (payload.mode === "plan") {
          setMainTab("plan");
        }
        await refreshAfterSend(selectedId);
        void refreshTasks();
        return true;
      } catch (e) {
        setError(String(e));
        void refreshDetail(selectedId);
        return false;
      }
    },
    [refreshAfterSend, refreshDetail, refreshTasks, selectedId],
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

  const cancelQueued = useCallback(
    async (runId: string) => {
      if (!selectedId || cancellingQueuedRunId) return;
      setCancellingQueuedRunId(runId);
      setError(null);
      try {
        const res = await api.cancelQueuedRun(selectedId, runId);
        setQueueLength(res.queueLength);
        await refreshDetail(selectedId);
      } catch (e) {
        setError(String(e));
      } finally {
        setCancellingQueuedRunId(null);
      }
    },
    [selectedId, cancellingQueuedRunId, refreshDetail],
  );

  const loadMore = useCallback(async () => {
    if (!selectedId || loadingMore || !hasMore) return;
    const oldest = events[0]?.seq;
    if (oldest == null) return;
    setLoadingMore(true);
    try {
      const r = await api.getEvents(selectedId, { before: oldest, limit: 100 });
      setEvents((prev) => mergeEventsBySeq(prev, r.events));
      setHasMore(r.hasMore);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [selectedId, loadingMore, hasMore, events]);

  const activeRunMode = useMemo((): AgentMode | undefined => {
    if (!running || !detail) return undefined;
    const activeRun = detail.runs.find((r) => r.status === "running");
    if (!activeRun) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.runId !== activeRun.runId) continue;
      if (ev.eventType === "user_message" || ev.eventType === "run_started") {
        const m = ev.payload?.mode;
        if (m === "plan" || m === "agent") return m;
      }
    }
    return "agent";
  }, [running, detail, events]);

  const planRunCount = useMemo(() => {
    const finished = new Set(
      (detail?.runs ?? [])
        .filter((r) => r.status === "finished")
        .map((r) => r.runId),
    );
    let count = 0;
    for (const ev of events) {
      if (
        ev.eventType === "user_message" &&
        ev.payload.mode === "plan" &&
        finished.has(ev.runId)
      ) {
        count += 1;
      }
    }
    return count;
  }, [events, detail]);

  const pendingPlanQuestions = useMemo(
    () => findPendingPlanQuestionBatch(events),
    [events],
  );
  // Boolean form for effects/UI so a freshly parsed batch object never causes
  // an effect to re-fire just because the underlying events array changed.
  const hasPendingPlanQuestions = pendingPlanQuestions != null;

  const submitPlanAnswers = useCallback(
    async (batch: PlanAnswerBatch) => {
      if (!selectedId) return;
      setError(null);
      setInterruptNotice(null);
      setStopping(false);
      try {
        const res = await api.sendMessage(
          selectedId,
          "",
          undefined,
          "plan",
          batch,
        );
        if (res.queued) {
          if (typeof res.queueLength === "number") {
            setQueueLength(res.queueLength);
          } else {
            setQueueLength((n) => n + 1);
          }
        } else {
          setRunning(true);
        }
        setMainTab("plan");
        await refreshAfterSend(selectedId);
        void refreshTasks();
      } catch (e) {
        setError(String(e));
        void refreshDetail(selectedId);
      }
    },
    [refreshAfterSend, refreshDetail, refreshTasks, selectedId],
  );

  // An unanswered plan question batch (only ever produced by a plan-mode run)
  // surfaces on the Plan tab.
  useEffect(() => {
    if (hasPendingPlanQuestions) {
      setMainTab("plan");
    }
  }, [hasPendingPlanQuestions]);

  const openPlanForRun = useCallback((runId: string) => {
    setSelectedPlanRunId(runId);
    setMainTab("plan");
  }, []);


  return (
    <div className="app">
      <header className="header">
        <div className="brand">Web Cursor</div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn header-settings"
            title="Token 用量统计（按时间）"
            onClick={() => setView("usage-stats")}
          >
            📈
          </button>
          <button
            type="button"
            className="icon-btn header-settings"
            title="Agent 运行状态"
            onClick={() => setView("agent-runtime")}
          >
            ⏱
          </button>
          <button
            type="button"
            className="icon-btn header-settings"
            title="全局设置"
            onClick={() => setView("global-settings")}
          >
            ⚙
          </button>
        </div>
        <div className="status">
          <span className={`dot ${auth?.ok ? "ok" : "bad"}`} />
          {auth?.ok ? auth.detail : "auth: not configured"}
          <span className="sep">·</span>
          <span className={`dot ${wsStatus === "connected" ? "ok" : "bad"}`} />
          ws: {wsStatus}
          <span className="sep">·</span>
          v{APP_VERSION}
        </div>
      </header>
      {(backendDown || wsStatus === "reconnecting") && (
        <div className="reconnect-banner" role="status">
          后端暂时不可达（可能正在部署重启）… 前端仍在自动重试轮询，不是卡死
        </div>
      )}
      {interruptNotice && !backendDown && wsStatus === "connected" && (
        <div className="interrupt-banner" role="status">
          {interruptNotice}
        </div>
      )}
      <div className="body">
        {view === "global-settings" ? (
          <GlobalSettingsPage onBack={() => setView("chat")} />
        ) : view === "project-settings" && selectedProjectId ? (
          <ProjectSettingsPage
            projectId={selectedProjectId}
            projectName={
              projects.find((p) => p.projectId === selectedProjectId)?.name ??
              selectedProjectId
            }
            onBack={() => setView("chat")}
          />
        ) : view === "usage-stats" ? (
          <UsageStatsPage
            defaultProjectId={selectedProjectId}
            onBack={() => setView("chat")}
          />
        ) : view === "agent-runtime" ? (
          <AgentRuntimePage onBack={() => setView("chat")} />
        ) : (
          <>
        <TaskList
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(id) => void selectProject(id)}
          onCreateProject={() => void createProject()}
          onRenameProject={() => void renameProject()}
          onSetGitRepoUrl={() => void setProjectGitRepoUrl()}
          onOpenProjectSettings={() => setView("project-settings")}
          tasks={tasks}
          selectedId={selectedId}
          onSelect={selectTask}
          onCreate={() => void openCreateTask()}
        />
        <main className="main">
          {selectedId && detail ? (
            <>
              <UsageBar task={detail.task} stats={detail.stats} />
              <div className="main-tabs">
                <button
                  type="button"
                  className={`main-tab${mainTab === "timeline" ? " active" : ""}`}
                  onClick={() => setMainTab("timeline")}
                >
                  Timeline
                </button>
                <button
                  type="button"
                  className={`main-tab${mainTab === "plan" ? " active" : ""}`}
                  onClick={() => setMainTab("plan")}
                >
                  Plan
                  {(planRunCount > 0 || hasPendingPlanQuestions) && (
                    <span className="main-tab-badge">
                      {planRunCount > 0 ? planRunCount : "●"}
                    </span>
                  )}
                </button>
              </div>
              {mainTab === "timeline" ? (
                <Timeline
                  events={events}
                  running={running}
                  queueLength={queueLength}
                  queuedRunIds={detail.runs
                    .filter((r) => r.status === "queued")
                    .map((r) => r.runId)}
                  hasMore={hasMore}
                  loadingMore={loadingMore}
                  onLoadMore={() => void loadMore()}
                  onPlanExportedClick={openPlanForRun}
                  onCancelQueued={(runId) => void cancelQueued(runId)}
                  cancellingQueuedRunId={cancellingQueuedRunId}
                />
              ) : (
                <>
                  {pendingPlanQuestions && (
                    <PlanQuestionsWizard
                      batch={pendingPlanQuestions}
                      disabled={running}
                      onSubmit={(answers) => void submitPlanAnswers(answers)}
                    />
                  )}
                  <PlanDocumentPanel
                    taskId={selectedId}
                    selectedRunId={selectedPlanRunId}
                    onSelectRunId={setSelectedPlanRunId}
                    onOpenSettings={() => setView("project-settings")}
                  />
                </>
              )}
              <ChatInput
                onSend={sendMessage}
                onStop={() => void stopAgent()}
                disabled={stopping}
                running={running}
                activeRunMode={activeRunMode}
                queueLength={queueLength}
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
          </>
        )}
      </div>
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error} ✕
        </div>
      )}
      {upgradingVersion ? (
        <div className="update-modal-backdrop" role="presentation">
          <div className="update-modal" role="dialog" aria-labelledby="update-modal-title">
            <h2 id="update-modal-title" className="update-modal-title">
              正在升级
            </h2>
            <div className="update-modal-upgrading">
              <span className="update-modal-spinner" aria-hidden="true" />
              <p className="update-modal-upgrading-text">
                正在升级到版本 <code>{upgradingVersion}</code>
              </p>
              <p className="update-modal-upgrading-hint">
                服务可用后会自动刷新页面，请稍候…
              </p>
            </div>
          </div>
        </div>
      ) : versionUpdate ? (
        <div className="update-modal-backdrop" role="presentation">
          <div className="update-modal" role="dialog" aria-labelledby="update-modal-title">
            <h2 id="update-modal-title" className="update-modal-title">
              系统版本已更新
            </h2>
            <p className="update-modal-body">
              当前页面版本为 <code>{versionUpdate.clientVersion}</code>，服务端已更新至{" "}
              <code>{versionUpdate.serverVersion}</code>。请刷新页面以获取最新功能。
            </p>
            <div className="update-modal-actions">
              <button
                type="button"
                className="update-modal-btn primary"
                onClick={() => {
                  setUpgradingVersion(versionUpdate.serverVersion);
                  beginUpgrade(versionUpdate.serverVersion);
                }}
              >
                更新版本
              </button>
              <button
                type="button"
                className="update-modal-btn"
                onClick={() => dismissVersionUpdate(versionUpdate.serverVersion)}
              >
                暂不更新
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {selectedProjectId && (
        <CreateTaskDialog
          open={showCreateTask}
          projectId={selectedProjectId}
          projectDefaultProvider={createTaskDefaults.provider}
          projectDefaultModel={createTaskDefaults.model}
          onClose={() => setShowCreateTask(false)}
          onCreate={createTask}
        />
      )}
    </div>
  );
}
