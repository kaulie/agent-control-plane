import fs from "node:fs";
import path from "node:path";
import type {
  AgentEvent,
  AgentSuccession,
  AgentSuccessionReason,
  AppSettings,
  Project,
  ProjectSettingsView,
  RunRecord,
  Task,
  TaskStats,
  TokenUsageSeries,
  UsageGranularity,
} from "../types.js";
import { Store, newId, DEFAULT_PROJECT_ID, SYSTEM_OPS_PROJECT_ID, WATCHDOG_USER_ID } from "../store/db.js";
import type { AgentProvider } from "../providers/types.js";
import {
  isProviderName,
  normalizeProviderName,
  type ProviderRegistry,
} from "../providers/registry.js";
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
import {
  CANONICAL_DEV_REPO,
  DEFAULT_AGENT_WORKSPACE_ROOT,
  projectAgentWorkspaceRoot,
} from "../config.js";
import { readCwdRules } from "../cwd-rules.js";
import {
  mergeSettings,
  resolvePlanExportDir,
  resolveRuntimeDefaults,
  resolveWorkspaceRoot,
} from "../settings.js";
import { exportPlanDocument } from "../plan-export.js";
import {
  formatPlanAnswerBatchForAgent,
  isPlanDraftText,
  parsePlanQuestionBatch,
  type PlanAnswerBatch,
} from "../plan-question-parser.js";
import { listPlanDocuments, readPlanDocument } from "../plan-documents.js";
import { buildTokenUsageSeries } from "../usage/series.js";
import {
  collectDecisionEvents,
  type DecisionContext,
} from "../decisions/index.js";

export type Publish = (message: Record<string, unknown>) => void;

export interface GatewayConfig {
  /** Root for per-task sandboxes (`<root>/<taskId>/`). */
  agentWorkspaceRoot: string;
  /** @deprecated alias of agentWorkspaceRoot */
  agentWorkspace?: string;
  /** Product source for system/ops tasks that must see the real tree. */
  canonicalDevRepo?: string;
  dataDir: string;
  /**
   * Capability snapshot for decision observers (proxy flags, etc.).
   * Optional — when omitted, observers that need ambient context no-op safely.
   */
  decisionContext?: DecisionContext;
  /** Global cap on concurrent agent runs across all tasks/providers. */
  maxConcurrentRuns?: number;
  /** Gateway RSS limit in MiB; 0 disables memory-triggered run shedding. */
  agentRssLimitMb?: number;
}

export interface SendMessageInput {
  text?: string;
  images?: PromptImage[];
  mode?: "agent" | "plan";
  /** Structured answers to a plan_question_batch (plan mode). */
  planAnswerBatch?: PlanAnswerBatch;
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
  planAnswerBatch?: PlanAnswerBatch;
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
  /** Global running count (all providers). */
  private runningCount = 0;
  private readonly maxConcurrentRuns: number;
  private readonly agentRssLimitMb: number;
  private memoryTimer: NodeJS.Timeout | undefined;
  private rssAboveLimit = false;

  constructor(
    private store: Store,
    private providers: ProviderRegistry,
    private config: GatewayConfig,
    private publish: Publish,
  ) {
    this.maxConcurrentRuns = Math.max(1, config.maxConcurrentRuns ?? 2);
    this.agentRssLimitMb = Math.max(0, config.agentRssLimitMb ?? 2048);
  }

  /** Resolve the live adapter for a task (falls back to registry default). */
  providerFor(task: Task): AgentProvider {
    const name = task.provider?.trim();
    if (name && this.providers.has(name)) {
      return this.providers.get(name);
    }
    return this.providers.default;
  }

  listProviders(): ProviderRegistry {
    return this.providers;
  }

  // ---- projects ----

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createProject(
    name: string,
    options?: { gitRepoUrl?: string },
  ): Project {
    const project = this.store.createProject(name, options);
    this.publish({ type: "project_created", project });
    return project;
  }

  renameProject(projectId: string, name: string): Project | undefined {
    return this.updateProject(projectId, { name });
  }

  updateProject(
    projectId: string,
    input: {
      name?: string;
      gitRepoUrl?: string | null;
    },
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

  /** Effective WorkspaceRoot from global settings, else env/default. */
  private effectiveWorkspaceRoot(): string {
    const fallback =
      this.config.agentWorkspaceRoot ||
      this.config.agentWorkspace ||
      DEFAULT_AGENT_WORKSPACE_ROOT;
    return resolveWorkspaceRoot(this.store.getGlobalSettings(), fallback);
  }

  getProjectSettingsView(projectId: string): ProjectSettingsView | undefined {
    const project = this.store.getProject(projectId);
    if (!project) return undefined;
    const global = this.store.getGlobalSettings();
    const projectSettings = this.store.getProjectSettings(projectId) ?? {};
    const cwd = projectAgentWorkspaceRoot(
      project.name,
      this.effectiveWorkspaceRoot(),
    );
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
    provider?: string;
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

    const globalSettings = this.store.getGlobalSettings();
    const projectSettings = this.store.getProjectSettings(projectId) ?? {};
    const runtimeDefaults = resolveRuntimeDefaults(globalSettings, projectSettings);

    const providerName = normalizeProviderName(
      input.provider ?? runtimeDefaults.defaultProvider,
      this.providers.defaultProviderName,
    );
    if (!isProviderName(providerName) || !this.providers.has(providerName)) {
      throw new Error(
        `Unknown agent provider "${providerName}". Supported: ${this.providers.names().join(", ")}`,
      );
    }

    const model =
      input.model?.trim() ||
      runtimeDefaults.defaultModel ||
      undefined;

    const taskId = newId("task");
    // cwd = WorkspaceRoot/{project_name}/{task_id}
    const projectRoot = projectAgentWorkspaceRoot(
      project.name,
      this.effectiveWorkspaceRoot(),
    );
    const workspace =
      input.workspace?.trim() || path.join(projectRoot, taskId);
    fs.mkdirSync(workspace, { recursive: true });

    const task = this.store.createTask({
      taskId,
      title,
      workspace,
      provider: providerName,
      model,
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

  getTokenUsageSeries(filter: {
    projectId?: string;
    granularity: UsageGranularity;
    timeZone?: "local" | "utc";
    from?: string;
    to?: string;
  }): TokenUsageSeries {
    return buildTokenUsageSeries(
      this.store.listUsageRunSamples({
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
      }),
      {
        granularity: filter.granularity,
        ...(filter.timeZone ? { timeZone: filter.timeZone } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
      },
    );
  }

  listAgentSuccessions(taskId: string): AgentSuccession[] {
    return this.store.listAgentSuccessions(taskId);
  }

  updateTaskPrUrl(taskId: string, prUrl: string | null): Task | undefined {
    const updated = this.store.updateTaskPrUrl(taskId, prUrl);
    if (updated) {
      this.publish({ type: "task_updated", task: updated });
    }
    return updated;
  }

  async createPullRequest(
    taskId: string,
    opts?: { title?: string; body?: string },
  ): Promise<{ task: Task; url: string; created: boolean }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const project = this.store.getProject(task.projectId);
    const gitRepoUrl = project?.gitRepoUrl?.trim();
    if (!gitRepoUrl) {
      throw new Error("project gitRepoUrl is required before opening a pull request");
    }
    if (task.prUrl?.trim()) {
      return { task, url: task.prUrl.trim(), created: false };
    }
    if (!fs.existsSync(path.join(task.workspace, ".git"))) {
      throw new Error(
        `task workspace is not a git repo: ${task.workspace} (clone ${gitRepoUrl} first)`,
      );
    }

    const { ensurePullRequest } = await import("../github-pr.js");
    const title =
      opts?.title?.trim() ||
      task.title?.trim() ||
      `Task ${task.taskId}`;
    const body =
      opts?.body?.trim() ||
      [
        "## Summary",
        `- taskId: ${task.taskId}`,
        `- project: ${project?.name ?? task.projectId}`,
        "",
        "## Test plan",
        "- [ ] Verify changes in review",
      ].join("\n");

    const result = await ensurePullRequest({
      cwd: task.workspace,
      title,
      body,
    });
    const updated = this.store.updateTaskPrUrl(taskId, result.url);
    if (!updated) throw new Error(`failed to persist prUrl for ${taskId}`);
    this.publish({ type: "task_updated", task: updated });
    return { task: updated, url: result.url, created: result.created };
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

  listPlanDocuments(taskId: string) {
    return listPlanDocuments(this.store, taskId);
  }

  getPlanDocument(taskId: string, runId: string) {
    return readPlanDocument(this.store, taskId, runId);
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
    return this.drainGlobalQueue();
  }

  /** Start periodic background guards (memory pressure). */
  startRuntimeGuards(): void {
    if (this.memoryTimer) return;
    this.memoryTimer = setInterval(() => this.checkMemoryPressure(), 15_000);
    this.memoryTimer.unref?.();
    console.warn(
      `[memory-guard] started maxConcurrentRuns=${this.maxConcurrentRuns} rssLimitMb=${
        this.agentRssLimitMb || "off"
      }`,
    );
  }

  stopRuntimeGuards(): void {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = undefined;
    }
  }

  private checkMemoryPressure(): void {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (this.agentRssLimitMb <= 0) return;

    if (rssMb <= this.agentRssLimitMb) {
      if (this.rssAboveLimit) {
        this.rssAboveLimit = false;
        console.warn(
          `[memory-guard] rss ${rssMb}MB back below limit ${this.agentRssLimitMb}MB`,
        );
      }
      return;
    }

    if (!this.rssAboveLimit) {
      this.rssAboveLimit = true;
      console.warn(
        `[memory-guard] rss ${rssMb}MB exceeds limit ${this.agentRssLimitMb}MB`,
      );
    }
    this.shedOldestRun(rssMb);
  }

  private shedOldestRun(rssMb: number): void {
    if (this.activeRuns.size === 0) return;
    const first = this.activeRuns.entries().next().value as
      | [string, string]
      | undefined;
    if (!first) return;
    const [taskId, runId] = first;

    try {
      const task = this.store.getTask(taskId);
      if (!task) return;
      console.warn(
        `[memory-guard] rss ${rssMb}MB; cancelling oldest active run task=${taskId} run=${runId}`,
      );
      void this.providerFor(task).cancel(runId);

      const event: AgentEvent = {
        eventId: newId("evt"),
        taskId,
        runId,
        agentId: task.agentId ?? "",
        timestamp: new Date().toISOString(),
        eventType: "status",
        payload: {
          status: "memory_pressure",
          message: `内存压力（RSS ${rssMb}MB）触发，已请求取消当前 run。`,
        },
      };
      this.store.appendEvent(event);
      this.publish({ type: "agent_event", event });
    } catch (err) {
      console.warn(
        "[memory-guard] failed to cancel oldest run:",
        err instanceof Error ? err.message : err,
      );
    }
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
    const planAnswerBatch =
      p.planAnswerBatch && typeof p.planAnswerBatch === "object"
        ? (p.planAnswerBatch as PlanAnswerBatch)
        : undefined;
    return {
      runId: run.runId,
      text,
      images,
      imageRefs,
      mode,
      planAnswerBatch,
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
    if (
      this.activeRuns.has(taskId) ||
      this.runningCount >= this.maxConcurrentRuns
    ) {
      return false;
    }
    const list = this.pendingRuns.get(taskId);
    if (!list?.length) return false;

    const task = this.store.getTask(taskId);
    if (!task) return false;

    const next = list.shift()!;
    if (!list.length) this.pendingRuns.delete(taskId);
    else this.pendingRuns.set(taskId, list);

    this.runningCount += 1;
    this.store.updateRun(next.runId, { status: "running" });
    this.activeRuns.set(taskId, next.runId);
    this.store.updateTaskStatus(taskId, "active");
    this.publishQueueUpdate(taskId);

    void this.executeRun(task, next);
    return true;
  }

  /** Start queued runs while global capacity remains. */
  private drainGlobalQueue(): number {
    let started = 0;
    const taskIds = [...this.pendingRuns.keys()];
    for (const taskId of taskIds) {
      if (this.runningCount >= this.maxConcurrentRuns) break;
      if (this.processNextPending(taskId)) started += 1;
    }
    return started;
  }

  private persistUserMessage(
    taskId: string,
    runId: string,
    agentId: string,
    input: {
      text: string;
      mode: "agent" | "plan";
      imageRefs: StoredImageRef[];
      planAnswerBatch?: PlanAnswerBatch;
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
    if (input.planAnswerBatch) payload.planAnswerBatch = input.planAnswerBatch;
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

    const images = input.images ?? [];
    let text = (input.text ?? "").trim();
    if (input.planAnswerBatch) {
      text = formatPlanAnswerBatchForAgent(input.planAnswerBatch);
    }
    if (!text && images.length === 0) {
      throw new Error("message text or at least one image is required");
    }

    let imageRefs: StoredImageRef[] = [];
    if (images.length) {
      imageRefs = saveTaskImages(this.config.dataDir, taskId, images);
    }

    const runId = newId("run");
    // Run mode is chosen by the user per message; it is never forced by the
    // task status. The provider maps `agent`/`plan` onto its own runtime mode
    // (Cursor agent/plan, Cline yolo/plan).
    const mode = input.mode === "plan" ? "plan" : "agent";
    const pending: PendingRun = {
      runId,
      text,
      images,
      imageRefs,
      mode,
      planAnswerBatch: input.planAnswerBatch,
      selfCheck: input.selfCheck,
    };

    const agentId = task.agentId ?? "";
    const isQueued =
      this.activeRuns.has(taskId) ||
      this.runningCount >= this.maxConcurrentRuns;

    this.store.createRun({
      runId,
      taskId,
      agentId,
      provider: this.providerFor(task).name,
      model: task.model,
      status: isQueued ? "queued" : "running",
    });

    const persistAndPublish = (event: AgentEvent): void => {
      this.store.appendEvent(event);
      if (event.eventType === "agent_succession") {
        this.recordAgentSuccession(event);
      }
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
        planAnswerBatch: input.planAnswerBatch,
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

    this.runningCount += 1;
    this.activeRuns.set(taskId, runId);
    this.store.updateTaskStatus(taskId, "active");
    void this.executeRun(task, pending);

    return {
      runId,
      queued: false,
      queueLength: this.getQueueLength(taskId),
    };
  }

  private publishPlanSideEffects(
    taskId: string,
    runId: string,
    agentId: string,
    mode: "agent" | "plan",
    event: AgentEvent,
    persistAndPublish: (event: AgentEvent) => void,
  ): void {
    if (mode !== "plan" || event.eventType !== "agent_response") {
      persistAndPublish(event);
      return;
    }
    const rawText =
      typeof event.payload.text === "string" ? event.payload.text : "";
    const { batch, strippedText } = parsePlanQuestionBatch(rawText);
    const displayText = batch ? strippedText : rawText;
    persistAndPublish({
      ...event,
      payload: {
        ...event.payload,
        text: displayText || (batch ? "(questions pending)" : rawText),
      },
    });
    if (batch) {
      persistAndPublish({
        eventId: newId("evt"),
        taskId,
        runId,
        agentId,
        timestamp: new Date().toISOString(),
        eventType: "plan_question_batch",
        payload: {
          batchId: batch.batchId,
          questions: batch.questions,
        },
      });
    }
    const draftSource = batch ? strippedText : rawText;
    if (isPlanDraftText(draftSource)) {
      persistAndPublish({
        eventId: newId("evt"),
        taskId,
        runId,
        agentId,
        timestamp: new Date().toISOString(),
        eventType: "plan_draft",
        payload: { text: draftSource },
      });
    }
  }

  private async executeRun(task: Task, pending: PendingRun): Promise<void> {
    const taskId = task.taskId;
    const { runId, text, images, mode, selfCheck } = pending;
    let agentId = task.agentId ?? "";
    const startedAt = Date.now();

    const persistAndPublish = (event: AgentEvent): void => {
      this.store.appendEvent(event);
      if (event.eventType === "agent_succession") {
        this.recordAgentSuccession(event);
      }
      this.publish({ type: "agent_event", event });
    };

    const decisionCtx: DecisionContext = this.config.decisionContext ?? {
      ambientProxyUrl: "",
      ambientShellProxy: false,
      mcpProxyAvailable: false,
    };
    const decisionSeen = new Set<string>();

    const persistWithDecisions = (event: AgentEvent): void => {
      persistAndPublish(event);
      for (const decision of collectDecisionEvents(decisionCtx, event, {
        seenKeys: decisionSeen,
      })) {
        persistAndPublish(decision);
      }
    };

    const publishEvent = (event: AgentEvent): void => {
      this.publishPlanSideEffects(
        taskId,
        runId,
        agentId,
        mode,
        event,
        persistWithDecisions,
      );
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

      // No plan-mode guidance is injected into the conversation: read-only
      // restrictions come solely from the provider's own `mode` parameter on
      // this run, so nothing lingers in long sessions when the user switches.
      const result = await this.providerFor(task).run({
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
          publishEvent(event);
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

      if (mode === "plan" && result.status === "finished") {
        const exportDir = resolvePlanExportDir(globalSettings, projectSettings);
        if (exportDir) {
          try {
            const { events: runEvents } = this.store.listEvents(taskId, {
              limit: 500,
            });
            const exported = exportPlanDocument({
              exportDir,
              task,
              project: project ?? undefined,
              runId,
              userText: text,
              runEvents: runEvents.filter((e) => e.runId === runId),
              runResult: result.result,
            });
            persistAndPublish({
              eventId: newId("evt"),
              taskId,
              runId,
              agentId,
              timestamp: new Date().toISOString(),
              eventType: "plan_exported",
              payload: {
                path: exported.filePath,
                fileName: exported.fileName,
              },
            });
          } catch (err) {
            console.warn(
              "[plan-export] failed:",
              err instanceof Error ? err.message : err,
            );
          }
        }
      }

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
      persistAndPublish({
        eventId: newId("evt"),
        taskId,
        runId,
        agentId,
        timestamp: new Date().toISOString(),
        eventType: "run_error",
        payload: {
          error: message,
          durationMs: Date.now() - startedAt,
        },
      });
    } finally {
      if (this.activeRuns.get(taskId) === runId) {
        this.activeRuns.delete(taskId);
      }
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.publish({
        type: "task_updated",
        task: this.store.getTask(taskId),
        stats: this.store.getTaskStats(taskId),
        runId,
      });
      this.drainGlobalQueue();
    }
  }

  /**
   * Persist an explicit agent-id succession row when providers emit
   * `agent_succession` (e.g. Cline plan↔yolo rebuild with seeded history).
   */
  private recordAgentSuccession(event: AgentEvent): void {
    const p = event.payload;
    const fromAgentId = typeof p.fromAgentId === "string" ? p.fromAgentId.trim() : "";
    const toAgentId = typeof p.toAgentId === "string" ? p.toAgentId.trim() : "";
    if (!fromAgentId || !toAgentId) {
      console.warn("[gateway] agent_succession missing from/to agent id; skip table write");
      return;
    }
    const reasonRaw = typeof p.reason === "string" ? p.reason.trim() : "";
    const reason: AgentSuccessionReason =
      reasonRaw === "session_unusable" ? "session_unusable" : "mode_change";
    try {
      this.store.insertAgentSuccession({
        successionId: newId("asn"),
        taskId: event.taskId,
        runId: event.runId,
        provider: typeof p.provider === "string" && p.provider.trim() ? p.provider.trim() : "unknown",
        fromAgentId,
        toAgentId,
        reason,
        fromMode: typeof p.fromMode === "string" ? p.fromMode : "",
        toMode: typeof p.toMode === "string" ? p.toMode : "",
        seededMessages:
          typeof p.seededMessages === "number" && Number.isFinite(p.seededMessages)
            ? Math.max(0, Math.floor(p.seededMessages))
            : 0,
        createdAt: event.timestamp,
      });
    } catch (err) {
      console.warn(
        "[gateway] insertAgentSuccession failed:",
        err instanceof Error ? err.message : err,
      );
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

    const cancelled = await this.providerFor(task).cancel(runId);
    if (!cancelled) {
      throw new Error("Failed to cancel the active run");
    }
    return { runId };
  }

  /**
   * Drop a queued (not yet started) run. Does not touch the active provider run.
   */
  cancelQueuedRun(
    taskId: string,
    runId: string,
  ): { runId: string; queueLength: number } {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const run = this.store.listRuns(taskId).find((r) => r.runId === runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.taskId !== taskId) throw new Error(`Run ${runId} not found`);
    if (run.status !== "queued") {
      throw new Error("Only queued runs can be cancelled this way");
    }

    const list = this.pendingRuns.get(taskId) ?? [];
    const next = list.filter((p) => p.runId !== runId);
    if (next.length === list.length) {
      // DB says queued but memory lost it (e.g. race) — still finalize DB.
    }
    if (next.length) this.pendingRuns.set(taskId, next);
    else this.pendingRuns.delete(taskId);

    const now = new Date().toISOString();
    this.store.updateRun(runId, {
      status: "cancelled",
      completedAt: now,
      error: "cancelled (queued message removed)",
    });

    const event: AgentEvent = {
      eventId: newId("evt"),
      taskId,
      runId,
      agentId: run.agentId ?? task.agentId ?? "",
      timestamp: now,
      eventType: "run_cancelled",
      payload: {
        reason: "user_cancel_queued",
        message: "已取消排队消息，不会再发送。",
      },
    };
    this.store.appendEvent(event);
    this.publish({ type: "agent_event", event });
    this.publishQueueUpdate(taskId);
    this.publish({
      type: "task_updated",
      task: this.store.getTask(taskId),
      stats: this.store.getTaskStats(taskId),
      runId,
    });

    return { runId, queueLength: this.getQueueLength(taskId) };
  }
}
