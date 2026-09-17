import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "./api";
import { connectWs, type ServerMessage } from "./ws";
import type { AgentEvent, AppView, AuthStatus, Project, Task, TaskDetail } from "./types";
import TaskList from "./components/TaskList";
import UsageBar from "./components/UsageBar";
import UsageStatsPage from "./components/UsageStatsPage";
import AgentBoardPage from "./components/AgentBoardPage";
import AgentTimelinePage from "./components/AgentTimelinePage";
import { AgentRuntimePage } from "./components/AgentRuntimePage";
import CreateTaskDialog from "./components/CreateTaskDialog";
import ProjectDialog, {
  type ProjectDialogMode,
  type ProjectDialogResult,
} from "./components/ProjectDialog";
import Timeline from "./components/Timeline";
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
  clearStaleWrite,
  dismissVersionUpdate,
  finishUpgrade,
  pollHealthVersion,
  reloadForUpdate,
  subscribeStaleWrite,
  subscribeUpgrade,
  subscribeVersionUpdate,
  UPGRADE_POLL_SECONDS,
  type StaleWriteNotice,
  type UpgradeState,
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
  /** Agent 时间线要打开哪个 agent（从看板点过来时带上）。 */
  const [timelineAgentId, setTimelineAgentId] = useState<string | null>(null);
  // Plan 只是 run 的一种模式：主界面不再有 Plan tab，也不再有 Plan 文档面板。
  const [versionUpdate, setVersionUpdate] = useState<VersionUpdate | null>(null);
  const [upgradeState, setUpgradeState] = useState<UpgradeState | null>(null);
  /** 写操作因「页面版本 ≠ 项目版本」被拒绝时的提示（必须先刷新页面）。 */
  const [staleWrite, setStaleWrite] = useState<StaleWriteNotice | null>(null);
  const [showCreateTask, setShowCreateTask] = useState(false);
  /** 项目相关的弹框（新建 / 重命名 / Git 地址），全部居中显示。 */
  const [projectDialog, setProjectDialog] = useState<ProjectDialogMode | null>(
    null,
  );
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

  // 写操作被拒绝（页面版本过期）时的提示：必须先刷新页面。
  useEffect(() => subscribeStaleWrite(setStaleWrite), []);

  // Live state of the "正在升级中，请等待" overlay (polled /health progress).
  useEffect(() => subscribeUpgrade(setUpgradeState), []);

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
          msg.type === "project_updated" ||
          // 部门是通过项目设置改的；左栏要显示它，所以也刷新项目列表。
          msg.type === "project_settings_updated"
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

  /** Agent 看板里点 task：先切到它所属 project，再打开这个 task。 */
  const openTaskFromBoard = useCallback(
    async (taskId: string, projectId: string) => {
      if (projectId !== selectedProjectRef.current) {
        await selectProject(projectId);
      }
      await selectTask(taskId);
      setView("chat");
    },
    [selectProject, selectTask],
  );

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

  const createProject = useCallback(
    async (input: ProjectDialogResult) => {
      const project = await api.createProject(input.name, {
        ...(input.gitRepoUrl ? { gitRepoUrl: input.gitRepoUrl } : {}),
        ...(input.department.departmentId || input.department.departmentName
          ? { department: input.department }
          : {}),
      });
      await refreshProjects();
      await selectProject(project.projectId);
    },
    [refreshProjects, selectProject],
  );

  const renameProject = useCallback(
    async (input: ProjectDialogResult) => {
      if (!selectedProjectId) return;
      await api.renameProject(selectedProjectId, input.name);
      await refreshProjects();
    },
    [refreshProjects, selectedProjectId],
  );

  const setProjectGitRepoUrl = useCallback(
    async (input: ProjectDialogResult) => {
      if (!selectedProjectId) return;
      await api.updateProject(selectedProjectId, {
        gitRepoUrl: input.gitRepoUrl,
      });
      await refreshProjects();
    },
    [refreshProjects, selectedProjectId],
  );

  const submitProjectDialog = useCallback(
    async (input: ProjectDialogResult): Promise<void> => {
      if (projectDialog === "create") return createProject(input);
      if (projectDialog === "rename") return renameProject(input);
      return setProjectGitRepoUrl(input);
    },
    [createProject, projectDialog, renameProject, setProjectGitRepoUrl],
  );

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
        await refreshAfterSend(selectedId);
        void refreshTasks();
        return true;
      } catch (e) {
        setError(errorText(e));
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
      setError(errorText(e));
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
        setError(errorText(e));
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

  const pendingPlanQuestions = useMemo(
    () => findPendingPlanQuestionBatch(events),
    [events],
  );

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
        await refreshAfterSend(selectedId);
        void refreshTasks();
      } catch (e) {
        setError(errorText(e));
        void refreshDetail(selectedId);
      }
    },
    [refreshAfterSend, refreshDetail, refreshTasks, selectedId],
  );

  // An unanswered plan question batch (only ever produced by a plan-mode run) is
  // rendered inline above the composer, so no tab switching is needed.

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
            title="Agent 时间线（某段时间内的 idle / thinking / working + 用户输入）"
            onClick={() => setView("agent-timeline")}
          >
            🕒
          </button>
          <button
            type="button"
            className="icon-btn header-settings"
            title="Agent 看板（所有 agent 的部门 / token / 工作时长）"
            onClick={() => setView("agent-board")}
          >
            🤖
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
      {(backendDown || wsStatus === "reconnecting") && !upgradeState && (
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
        ) : view === "agent-board" ? (
          <AgentBoardPage
            onOpenTask={(taskId, projectId) =>
              void openTaskFromBoard(taskId, projectId)
            }
            onOpenTimeline={(agentId) => {
              setTimelineAgentId(agentId);
              setView("agent-timeline");
            }}
            onBack={() => setView("chat")}
          />
        ) : view === "agent-timeline" ? (
          <AgentTimelinePage
            defaultAgentId={timelineAgentId}
            onOpenTask={(taskId, projectId) =>
              void openTaskFromBoard(taskId, projectId)
            }
            onBack={() => setView("chat")}
          />
        ) : (
          <>
        <TaskList
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={(id) => void selectProject(id)}
          onCreateProject={() => setProjectDialog("create")}
          onRenameProject={() => setProjectDialog("rename")}
          onSetGitRepoUrl={() => setProjectDialog("gitRepoUrl")}
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
                onCancelQueued={(runId) => void cancelQueued(runId)}
                cancellingQueuedRunId={cancellingQueuedRunId}
              />
              {pendingPlanQuestions && (
                <PlanQuestionsWizard
                  batch={pendingPlanQuestions}
                  disabled={running}
                  onSubmit={(answers) => void submitPlanAnswers(answers)}
                />
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
      {staleWrite ? (
        <div className="update-modal-backdrop" role="presentation">
          <div
            className="update-modal"
            role="dialog"
            aria-labelledby="stale-write-modal-title"
          >
            <h2 id="stale-write-modal-title" className="update-modal-title">
              页面版本已过期，本次提交被拒绝
            </h2>
            <p className="update-modal-body">
              当前页面版本为 <code>{staleWrite.clientVersion}</code>，
              {staleWrite.serverVersion ? (
                <>
                  {" "}
                  项目当前版本为 <code>{staleWrite.serverVersion}</code>。
                </>
              ) : (
                " 无法确认与项目当前版本是否一致。"
              )}{" "}
              为避免用旧界面覆盖新版本的数据，写操作已被拒绝（未提交）。
              <strong>请先刷新页面，再重新提交。</strong>
            </p>
            <div className="update-modal-actions">
              <button
                type="button"
                className="update-modal-btn primary"
                onClick={() => {
                  const target = staleWrite.serverVersion;
                  clearStaleWrite();
                  if (target) beginUpgrade(target);
                  else reloadForUpdate();
                }}
              >
                立即刷新
              </button>
              <button
                type="button"
                className="update-modal-btn"
                onClick={() => clearStaleWrite()}
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : upgradeState ? (
        <div className="update-modal-backdrop" role="presentation">
          <div
            className="update-modal"
            role="dialog"
            aria-labelledby="update-modal-title"
            aria-busy={!upgradeState.timedOut}
          >
            <h2 id="update-modal-title" className="update-modal-title">
              {upgradeState.timedOut ? "升级等待超时" : "正在升级中，请等待"}
            </h2>
            <div className="update-modal-upgrading">
              {upgradeState.timedOut ? (
                <span className="update-modal-icon" aria-hidden="true">
                  ⚠️
                </span>
              ) : (
                <span className="update-modal-spinner" aria-hidden="true" />
              )}
              <p className="update-modal-upgrading-text">
                目标版本 <code>{upgradeState.target}</code>
              </p>
              <p className="update-modal-upgrading-hint">
                {upgradeState.timedOut
                  ? "等待超时，服务可能仍在重启。可稍等片刻后手动刷新。"
                  : upgradeState.unreachable
                    ? "服务正在重启，暂时不可达；正在每 " +
                      `${UPGRADE_POLL_SECONDS} 秒重试…`
                    : `服务端磁盘版本已就绪（${upgradeState.serverVersion ?? "—"}），` +
                      "正在等待新进程接管…"}
              </p>
              <p className="update-modal-upgrading-meta">
                已轮询 {upgradeState.attempts} 次 · 每 {UPGRADE_POLL_SECONDS}s 一次
                · 已等待 {Math.round(upgradeState.elapsedMs / 1000)}s
                {upgradeState.processVersion
                  ? ` · 当前进程 ${upgradeState.processVersion}`
                  : ""}
              </p>
              {!upgradeState.timedOut && (
                <p className="update-modal-upgrading-hint">
                  新进程就绪后会自动刷新页面，无需操作。
                </p>
              )}
            </div>
            <div className="update-modal-actions">
              <button
                type="button"
                className="update-modal-btn"
                onClick={() => {
                  finishUpgrade();
                  reloadForUpdate(upgradeState.target);
                }}
              >
                立即刷新
              </button>
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
                onClick={() => beginUpgrade(versionUpdate.serverVersion)}
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
      <ProjectDialog
        open={projectDialog !== null}
        mode={projectDialog ?? "create"}
        initialName={
          projectDialog === "rename"
            ? (projects.find((p) => p.projectId === selectedProjectId)?.name ??
              "")
            : ""
        }
        initialGitRepoUrl={
          projectDialog === "gitRepoUrl"
            ? (projects.find((p) => p.projectId === selectedProjectId)
                ?.gitRepoUrl ?? "")
            : ""
        }
        onClose={() => setProjectDialog(null)}
        onSubmit={submitProjectDialog}
      />
    </div>
  );
}
