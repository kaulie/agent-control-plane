import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, AppSettings, Project, ProjectSettingsView, RunRecord, Task, TaskStats } from "../types.js";
import { Store, newId, DEFAULT_PROJECT_ID, SYSTEM_OPS_PROJECT_ID, WATCHDOG_USER_ID } from "../store/db.js";
import type { AgentProvider } from "../providers/types.js";
import {
  saveTaskImages,
  loadPromptImagesFromRefs,
  type PromptImage,
  type StoredImageRef,
} from "../attachments.js";
import { buildTaskBootstrapText } from "../task-context.js";
import {
  buildSelfCheckPrompt,
  findTasksNeedingSelfCheck,
} from "../feedback.js";
import { CANONICAL_DEV_REPO, DEFAULT_AGENT_WORKSPACE_ROOT } from "../config.js";
import { readCwdRules } from "../cwd-rules.js";
import { mergeSettings } from "../settings.js";

export type Publish = (message: Record<string, unknown>) => void;

export interface GatewayConfig {
  /** Root for per-task sandboxes (`<root>/<taskId>/`). */
  agentWorkspaceRoot: string;
  /** @deprecated alias of agentWorkspaceRoot */
  agentWorkspace?: string;
  /** Product source for system/ops tasks that must see the real tree. */
  canonicalDevRepo?: string;
  dataDir: string;
}

export interface SendMessageInput {
  text?: string;
  images?: PromptImage[];
  mode?: "agent" | "plan";
  /** Startup self-check for a run that never received terminal feedback. */
  selfCheck?: { resumesRunId: string };
}

export interface TaskDetail {
  task: Task;
  runs: RunRecord[];
  stats: TaskStats;
}

interface PendingRun {
  runId: string;
  text: string;
  images: PromptImage[];
  imageRefs: StoredImageRef[];
  mode: "agent" | "plan";
  selfCheck?: { resumesRunId: string };
}

export interface SendMessageResult {
  runId: string;
  queued: boolean;
  queueLength: number;
}

/**
 * Orchestrates the core loop required by the spec:
 *   Task -> Agent Run -> Event Stream -> Usage -> Cost -> Result
 * It depends only on the AgentProvider interface (never a concrete SDK).
 */
export class AgentGateway {
  /** In-flight runId keyed by taskId (at most one active run per task). */
  private activeRuns = new Map<string, string>();
  /** Per-task FIFO of runs waiting while another run is active. */
  private pendingRuns = new Map<string, PendingRun[]>();

  constructor(
    private store: Store,
    private provider: AgentProvider,
    private config: GatewayConfig,
    private publish: Publish,
  ) {}

  // ---- projects ----

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createProject(name: string, workspaceRoot?: string): Project {
    const project = this.store.createProject(name, workspaceRoot);
    this.publish({ type: "project_created", project });
    return project;
  }

  renameProject(projectId: string, name: string): Project | undefined {
    return this.updateProject(projectId, { name });
  }

  updateProject(
    projectId: string,
    input: { name?: string; workspaceRoot?: string | null },
  ): Project | undefined {
    const project = this.store.updateProject(projectId, input);
    if (project) {
      this.publish({ type: "project_updated", project });
    }
    return project;
  }

  getProject(projectId: string): Project | undefined {
    return this.store.getProject(projectId);
  }

  // ---- settings ----

  getGlobalSettings(): AppSettings {
    return this.store.getGlobalSettings();
  }

  updateGlobalSettings(patch: AppSettings): AppSettings {
    const settings = this.store.updateGlobalSettings(patch);
    this.publish({ type: "global_settings_updated", settings });
    return settings;
  }

  getProjectSettingsView(projectId: string): ProjectSettingsView | undefined {
    const project = this.store.getProject(projectId);
    if (!project) return undefined;
    const global = this.store.getGlobalSettings();
    const projectSettings = this.store.getProjectSettings(projectId) ?? {};
    const cwd =
      project.workspaceRoot?.trim() ||
      this.config.canonicalDevRepo?.trim() ||
      "";
    return {
      global,
      project: projectSettings,
      effective: mergeSettings(global, projectSettings),
      cwdRules: cwd ? readCwdRules(cwd) : undefined,
    };
  }

  updateProjectSettings(
    projectId: string,
    patch: AppSettings,
  ): ProjectSettingsView | undefined {
    if (!this.store.updateProjectSettings(projectId, patch)) return undefined;
    const view = this.getProjectSettingsView(projectId);
    if (view) {
      this.publish({ type: "project_settings_updated", projectId, settings: view });
    }
    return view;
  }

  // ---- tasks ----

  createTask(input: {
    title?: string;
    workspace?: string;
    model?: string;
    projectId?: string;
    createdBy?: string;
  }): Task {
    const title = input.title?.trim() || `Task ${new Date().toLocaleString()}`;
    const projectId = input.projectId?.trim() || DEFAULT_PROJECT_ID;
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new Error(`project ${projectId} not found`);
    }

    const taskId = newId("task");
    const globalRoot =
      this.config.agentWorkspaceRoot ||
      this.config.agentWorkspace ||
      DEFAULT_AGENT_WORKSPACE_ROOT;
    const projectRoot = project.workspaceRoot?.trim();
    const workspace =
      input.workspace?.trim() ||
      path.join(projectRoot || globalRoot, taskId);
    fs.mkdirSync(workspace, { recursive: true });

    const task = this.store.createTask({
      taskId,
      title,
      workspace,
      provider: this.provider.name,
      model: input.model,
      projectId,
      createdBy: input.createdBy,
    });
    this.publish({ type: "task_created", task });
    return task;
  }

  listTasks(filter?: { projectId?: string }): Task[] {
    return this.store.listTasks(filter);
  }

  getTaskDetail(taskId: string): TaskDetail | undefined {
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    return {
      task,
      runs: this.store.listRuns(taskId),
      stats: this.store.getTaskStats(taskId),
    };
  }

  /**
   * 看门狗触发的崩溃分析：在「系统运维」项目下自动建一个任务，
   * 以 watchdog 用户身份向 agent 下发崩溃原因探查指令。
   */
  async createCrashAnalysisTask(): Promise<void> {
    const task = this.createTask({
      title: "系统崩溃分析 - system crash auto analyze",
      projectId: SYSTEM_OPS_PROJECT_ID,
      createdBy: WATCHDOG_USER_ID,
      // Ops task must see the product tree / logs, not an empty sandbox.
      workspace:
        this.config.canonicalDevRepo?.trim() || CANONICAL_DEV_REPO,
    });
    const prompt = [
      "系统检测到上一次运行发生异常退出（疑似崩溃）。请协助排查崩溃原因：",
      "1. 查看 backend/server.log 日志，定位最后的错误或异常；",
      "2. 检查数据库中最近未正常结束的 run 和相关事件；",
      "3. 推断可能的根因（如内存溢出、未捕获异常、SDK 崩溃等）；",
      "4. 给出简要结论和修复建议。",
      "请用中文回复。",
    ].join("\n");
    await this.sendMessage(task.taskId, { text: prompt });
  }

  listEvents(
    taskId: string,
    opts?: { after?: number; before?: number; limit?: number },
  ): { events: AgentEvent[]; hasMore: boolean } {
    return this.store.listEvents(taskId, opts);
  }

  maxEventSeq(taskId: string): number {
    return this.store.maxEventSeq(taskId);
  }

  getQueueLength(taskId: string): number {
    return this.pendingRuns.get(taskId)?.length ?? 0;
  }

  /** Rebuild in-memory queues from DB and start draining where idle. */
  recoverQueuedRuns(): number {
    const queued = this.store.listAllQueuedRuns();
    for (const run of queued) {
      const pending = this.pendingFromRun(run);
      if (!pending) continue;
      const list = this.pendingRuns.get(run.taskId) ?? [];
      if (list.some((p) => p.runId === run.runId)) continue;
      list.push(pending);
      this.pendingRuns.set(run.taskId, list);
    }
    const taskIds = [...new Set(queued.map((r) => r.taskId))];
    let started = 0;
    for (const taskId of taskIds) {
      if (this.activeRuns.has(taskId)) continue;
      if (this.processNextPending(taskId)) started += 1;
    }
    return started;
  }

  private pendingFromRun(run: RunRecord): PendingRun | undefined {
    const { events } = this.store.listEvents(run.taskId, { limit: 500 });
    const msg = events.find(
      (e) => e.runId === run.runId && e.eventType === "user_message",
    );
    if (!msg) return undefined;
    const p = msg.payload;
    const text = typeof p.text === "string" ? p.text : "";
    const mode = p.mode === "plan" ? "plan" : "agent";
    const imageRefs: StoredImageRef[] = [];
    if (Array.isArray(p.images)) {
      for (const item of p.images) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.mimeType !== "string") continue;
        imageRefs.push({
          id: o.id,
          mimeType: o.mimeType,
          byteLength: typeof o.byteLength === "number" ? o.byteLength : 0,
          ...(typeof o.width === "number" ? { width: o.width } : {}),
          ...(typeof o.height === "number" ? { height: o.height } : {}),
        });
      }
    }
    const images = loadPromptImagesFromRefs(
      this.config.dataDir,
      run.taskId,
      imageRefs,
    );
    const selfCheck =
      p.selfCheck === true && typeof p.resumesRunId === "string"
        ? { resumesRunId: p.resumesRunId }
        : undefined;
    return {
      runId: run.runId,
      text,
      images,
      imageRefs,
      mode,
      selfCheck,
    };
  }

  private publishQueueUpdate(taskId: string): void {
    this.publish({
      type: "task_queue_updated",
      taskId,
      queueLength: this.getQueueLength(taskId),
    });
  }

  private enqueuePending(taskId: string, pending: PendingRun): void {
    const list = this.pendingRuns.get(taskId) ?? [];
    list.push(pending);
    this.pendingRuns.set(taskId, list);
    this.publishQueueUpdate(taskId);
  }

  /** Returns true if a run was started. */
  private processNextPending(taskId: string): boolean {
    if (this.activeRuns.has(taskId)) return false;
    const list = this.pendingRuns.get(taskId);
    if (!list?.length) return false;

    const next = list.shift()!;
    if (!list.length) this.pendingRuns.delete(taskId);
    else this.pendingRuns.set(taskId, list);

    this.store.updateRun(next.runId, { status: "running" });
    this.activeRuns.set(taskId, next.runId);
    this.store.updateTaskStatus(taskId, "active");
    this.publishQueueUpdate(taskId);

    const task = this.store.getTask(taskId);
    if (!task) {
      this.activeRuns.delete(taskId);
      return false;
    }
    void this.executeRun(task, next);
    return true;
  }

  private persistUserMessage(
    taskId: string,
    runId: string,
    agentId: string,
    input: {
      text: string;
      mode: "agent" | "plan";
      imageRefs: StoredImageRef[];
      selfCheck?: { resumesRunId: string };
      queued?: boolean;
    },
    persistAndPublish: (event: AgentEvent) => void,
  ): void {
    const payload: Record<string, unknown> = {
      text: input.text,
      mode: input.mode,
    };
    if (input.queued) payload.queued = true;
    if (input.selfCheck) {
      payload.selfCheck = true;
      payload.resumesRunId = input.selfCheck.resumesRunId;
    }
    if (input.imageRefs.length) {
      payload.images = input.imageRefs.map((ref) => ({
        id: ref.id,
        mimeType: ref.mimeType,
        byteLength: ref.byteLength,
        ...(ref.width != null ? { width: ref.width } : {}),
        ...(ref.height != null ? { height: ref.height } : {}),
      }));
    }
    persistAndPublish({
      eventId: newId("evt"),
      taskId,
      runId,
      agentId,
      timestamp: new Date().toISOString(),
      eventType: "user_message",
      payload,
    });
  }

  async sendMessage(
    taskId: string,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const text = (input.text ?? "").trim();
    const images = input.images ?? [];
    if (!text && images.length === 0) {
      throw new Error("message text or at least one image is required");
    }

    let imageRefs: StoredImageRef[] = [];
    if (images.length) {
      imageRefs = saveTaskImages(this.config.dataDir, taskId, images);
    }

    const runId = newId("run");
    const mode = input.mode === "plan" ? "plan" : "agent";
    const pending: PendingRun = {
      runId,
      text,
      images,
      imageRefs,
      mode,
      selfCheck: input.selfCheck,
    };

    const agentId = task.agentId ?? "";
    const isQueued = this.activeRuns.has(taskId);

    this.store.createRun({
      runId,
      taskId,
      agentId,
      provider: this.provider.name,
      model: task.model,
      status: isQueued ? "queued" : "running",
    });

    const persistAndPublish = (event: AgentEvent): void => {
      this.store.appendEvent(event);
      this.publish({ type: "agent_event", event });
    };

    this.persistUserMessage(
      taskId,
      runId,
      agentId,
      {
        text,
        mode,
        imageRefs,
        selfCheck: input.selfCheck,
        queued: isQueued,
      },
      persistAndPublish,
    );

    if (isQueued) {
      this.enqueuePending(taskId, pending);
      return {
        runId,
        queued: true,
        queueLength: this.getQueueLength(taskId),
      };
    }

    this.activeRuns.set(taskId, runId);
    this.store.updateTaskStatus(taskId, "active");
    void this.executeRun(task, pending);

    return {
      runId,
      queued: false,
      queueLength: this.getQueueLength(taskId),
    };
  }

  private async executeRun(task: Task, pending: PendingRun): Promise<void> {
    const taskId = task.taskId;
    const { runId, text, images, mode, selfCheck } = pending;
    let agentId = task.agentId ?? "";

    const persistAndPublish = (event: AgentEvent): void => {
      this.store.appendEvent(event);
      this.publish({ type: "agent_event", event });
    };

    const bindAgentId = (id: string): void => {
      if (!id || id === agentId) return;
      agentId = id;
      this.store.setRunAgentId(runId, agentId);
      if (!task.agentId || task.agentId !== agentId) {
        this.store.setTaskAgentId(taskId, agentId);
        task.agentId = agentId;
      }
    };

    try {
      const { events: priorEvents } = this.store.listEvents(taskId, {
        limit: 200,
      });
      const historyEvents = priorEvents.filter((e) => e.runId !== runId);
      const project = this.store.getProject(task.projectId);
      const globalSettings = this.store.getGlobalSettings();
      const projectSettings = project
        ? (this.store.getProjectSettings(project.projectId) ?? {})
        : {};
      const effectiveRules = mergeSettings(globalSettings, projectSettings).agent
        ?.rules;
      const bootstrapText = buildTaskBootstrapText({
        task,
        project,
        events: historyEvents,
        runs: this.store.listRuns(taskId).filter((r) => r.runId !== runId),
        effectiveRules,
      });

      const result = await this.provider.run({
        taskId,
        runId,
        agentId,
        prompt: {
          text,
          images: images.length ? images : undefined,
        },
        cwd: task.workspace,
        model: task.model,
        mode,
        bootstrapText,
        agentName: task.title,
        onEvent: (event) => {
          if (event.agentId) bindAgentId(event.agentId);
          persistAndPublish(event);
        },
      });

      if (result.agentId) bindAgentId(result.agentId);

      this.store.updateRun(runId, {
        status: result.status,
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        result: result.result,
        error: result.error,
        usage: result.usage,
        cost: result.cost,
        modelCalls: result.modelCalls,
        toolCalls: result.toolCalls,
      });
      this.store.updateTaskStatus(
        taskId,
        result.status === "error"
          ? "error"
          : result.status === "cancelled"
            ? "active"
            : "completed",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.updateRun(runId, {
        status: "error",
        completedAt: new Date().toISOString(),
        error: message,
      });
      this.store.updateTaskStatus(taskId, "error");
    } finally {
      if (this.activeRuns.get(taskId) === runId) {
        this.activeRuns.delete(taskId);
      }
      this.publish({
        type: "task_updated",
        task: this.store.getTask(taskId),
        stats: this.store.getTaskStats(taskId),
        runId,
      });
      this.processNextPending(taskId);
    }
  }

  /**
   * After restart: any user message whose run lacks terminal feedback
   * (e.g. server_restart cancel) gets an automatic self-check run.
   */
  async runPendingSelfChecks(): Promise<number> {
    const pending = findTasksNeedingSelfCheck(this.store);
    let started = 0;
    for (const { taskId, unclosed } of pending) {
      const text = buildSelfCheckPrompt(unclosed);
      try {
        await this.sendMessage(taskId, {
          text,
          mode: "agent",
          selfCheck: { resumesRunId: unclosed.runId },
        });
        started += 1;
        console.warn(
          `[self-check] task ${taskId}: resuming feedback for run ${unclosed.runId}`,
        );
      } catch (err) {
        console.warn(
          `[self-check] task ${taskId} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return started;
  }

  async stopTask(taskId: string): Promise<{ runId: string }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const runId = this.activeRuns.get(taskId);
    if (!runId) {
      throw new Error("No active run to stop");
    }

    const cancelled = await this.provider.cancel(runId);
    if (!cancelled) {
      throw new Error("Failed to cancel the active run");
    }
    return { runId };
  }
}
