import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CostInfo,
  EventType,
  Project,
  RunRecord,
  RunStatus,
  Task,
  TaskStats,
  TaskStatus,
  TokenUsage,
} from "../types.js";

export const DEFAULT_PROJECT_ID = "project-default";
export const DEFAULT_PROJECT_NAME = "Default";

export const SYSTEM_OPS_PROJECT_ID = "project-system-ops";
export const SYSTEM_OPS_PROJECT_NAME = "系统运维";
export const WATCHDOG_USER_ID = "watchdog";
export const WATCHDOG_USER_NAME = "Watchdog";

interface ProjectRow {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface UserRow {
  user_id: string;
  name: string;
  is_system: number;
  created_at: string;
}

interface TaskRow {
  task_id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  status: string;
  workspace: string;
  provider: string;
  model: string | null;
  created_by: string | null;
  agent_id: string | null;
}

interface RunRow {
  run_id: string;
  task_id: string;
  agent_id: string;
  provider: string;
  model: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  result: string | null;
  error: string | null;
  usage_json: string | null;
  cost_json: string | null;
  model_calls: number;
  tool_calls: number;
}

interface EventRow {
  seq: number;
  event_id: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  timestamp: string;
  event_type: string;
  payload: string;
  usage: string | null;
  cost: string | null;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "web_cursor.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id   TEXT PRIMARY KEY,
        title     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status    TEXT NOT NULL,
        workspace TEXT NOT NULL,
        provider  TEXT NOT NULL,
        model     TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id      TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        result      TEXT,
        error       TEXT,
        usage_json  TEXT,
        cost_json   TEXT,
        model_calls INTEGER NOT NULL DEFAULT 0,
        tool_calls  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
      CREATE TABLE IF NOT EXISTS events (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id  TEXT UNIQUE NOT NULL,
        task_id   TEXT NOT NULL,
        run_id    TEXT NOT NULL,
        agent_id  TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload   TEXT NOT NULL,
        usage     TEXT,
        cost      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS projects (
        project_id  TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        user_id   TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    const taskCols = this.db
      .prepare(`PRAGMA table_info(tasks)`)
      .all() as unknown as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === "project_id")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN project_id TEXT`);
    }
    if (!taskCols.some((c) => c.name === "created_by")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN created_by TEXT`);
    }
    if (!taskCols.some((c) => c.name === "agent_id")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN agent_id TEXT`);
    }

    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`,
    );

    // Backfill: bind each task to its most recent non-empty run agent_id.
    this.db.exec(`
      UPDATE tasks
      SET agent_id = (
        SELECT r.agent_id FROM runs r
        WHERE r.task_id = tasks.task_id
          AND r.agent_id IS NOT NULL
          AND r.agent_id != ''
        ORDER BY r.created_at DESC
        LIMIT 1
      )
      WHERE (agent_id IS NULL OR agent_id = '')
        AND EXISTS (
          SELECT 1 FROM runs r
          WHERE r.task_id = tasks.task_id
            AND r.agent_id IS NOT NULL
            AND r.agent_id != ''
        )
    `);

    const now = new Date().toISOString();
    const defaultRow = this.db
      .prepare(`SELECT project_id FROM projects WHERE project_id = ?`)
      .get(DEFAULT_PROJECT_ID) as { project_id: string } | undefined;
    if (!defaultRow) {
      this.db
        .prepare(
          `INSERT INTO projects (project_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, now, now);
    }

    this.db
      .prepare(
        `UPDATE tasks SET project_id = ? WHERE project_id IS NULL OR project_id = ''`,
      )
      .run(DEFAULT_PROJECT_ID);

    // 内置「系统运维」项目 + watchdog 特殊用户（提前注册）
    if (
      !this.db
        .prepare(`SELECT project_id FROM projects WHERE project_id = ?`)
        .get(SYSTEM_OPS_PROJECT_ID)
    ) {
      this.db
        .prepare(
          `INSERT INTO projects (project_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(SYSTEM_OPS_PROJECT_ID, SYSTEM_OPS_PROJECT_NAME, now, now);
    }
    if (
      !this.db
        .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
        .get(WATCHDOG_USER_ID)
    ) {
      this.db
        .prepare(
          `INSERT INTO users (user_id, name, is_system, created_at)
           VALUES (?, ?, 1, ?)`,
        )
        .run(WATCHDOG_USER_ID, WATCHDOG_USER_NAME, now);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * On startup, mark any run left "running" by a previous process as cancelled,
   * append a terminal timeline event, and return orphans for SDK cleanup plus
   * finalized rows so the gateway can push them to reconnecting browsers.
   */
  markInterruptedRuns(): {
    orphans: Array<{ agentId: string; cwd: string }>;
    finalized: Array<{
      taskId: string;
      runId: string;
      event: AgentEvent;
    }>;
  } {
    const rows = this.db
      .prepare(
        `SELECT r.run_id AS run_id,
                r.task_id AS task_id,
                r.agent_id AS agent_id,
                r.created_at AS created_at,
                t.workspace AS workspace
         FROM runs r
         JOIN tasks t ON t.task_id = r.task_id
         WHERE r.status = 'running'`,
      )
      .all() as Array<{
      run_id: string;
      task_id: string;
      agent_id: string | null;
      created_at: string;
      workspace: string;
    }>;

    const now = new Date().toISOString();
    const finalized: Array<{
      taskId: string;
      runId: string;
      event: AgentEvent;
    }> = [];
    const orphanKeys = new Set<string>();
    const orphans: Array<{ agentId: string; cwd: string }> = [];

    for (const row of rows) {
      const createdMs = Date.parse(row.created_at);
      const durationMs = Number.isFinite(createdMs)
        ? Math.max(0, Date.now() - createdMs)
        : undefined;
      this.db
        .prepare(
          `UPDATE runs
           SET status = 'cancelled',
               completed_at = ?,
               error = ?,
               duration_ms = COALESCE(?, duration_ms)
           WHERE run_id = ?`,
        )
        .run(
          now,
          "interrupted (server restart)",
          durationMs ?? null,
          row.run_id,
        );
      this.updateTaskStatus(row.task_id, "active");

      const event: AgentEvent = {
        eventId: newId("evt"),
        taskId: row.task_id,
        runId: row.run_id,
        agentId: row.agent_id ?? "",
        timestamp: now,
        eventType: "run_cancelled",
        payload: {
          reason: "server_restart",
          message:
            "任务因服务重启中断（例如部署）。状态已同步为结束，可继续发消息接着做。",
          ...(durationMs != null ? { durationMs } : {}),
        },
      };
      this.appendEvent(event);
      finalized.push({
        taskId: row.task_id,
        runId: row.run_id,
        event,
      });

      if (row.agent_id) {
        const key = `${row.agent_id}::${row.workspace}`;
        if (!orphanKeys.has(key)) {
          orphanKeys.add(key);
          orphans.push({ agentId: row.agent_id, cwd: row.workspace });
        }
      }
    }

    return { orphans, finalized };
  }

  // ---- projects ----

  listProjects(): Project[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects ORDER BY name ASC`)
      .all() as unknown as ProjectRow[];
    return rows.map((r) => this.toProject(r));
  }

  getProject(projectId: string): Project | undefined {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE project_id = ?`)
      .get(projectId) as ProjectRow | undefined;
    return row ? this.toProject(row) : undefined;
  }

  createProject(name: string): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("project name is required");
    const now = new Date().toISOString();
    const project: Project = {
      projectId: newId("project"),
      name: trimmed,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (project_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(project.projectId, project.name, project.createdAt, project.updatedAt);
    return project;
  }

  renameProject(projectId: string, name: string): Project | undefined {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("project name is required");
    const existing = this.getProject(projectId);
    if (!existing) return undefined;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE project_id = ?`)
      .run(trimmed, updatedAt, projectId);
    return { ...existing, name: trimmed, updatedAt };
  }

  private toProject(r: ProjectRow): Project {
    return {
      projectId: r.project_id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ---- tasks ----

  createTask(input: {
    title: string;
    workspace: string;
    provider: string;
    model?: string;
    projectId: string;
    createdBy?: string;
    /** Optional pre-allocated id (used when workspace path embeds taskId). */
    taskId?: string;
  }): Task {
    if (!this.getProject(input.projectId)) {
      throw new Error(`project ${input.projectId} not found`);
    }
    const task: Task = {
      taskId: input.taskId?.trim() || newId("task"),
      projectId: input.projectId,
      title: input.title,
      createdAt: new Date().toISOString(),
      status: "active",
      workspace: input.workspace,
      provider: input.provider,
      model: input.model,
      createdBy: input.createdBy,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, project_id, title, created_at, status, workspace, provider, model, created_by, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.projectId,
        task.title,
        task.createdAt,
        task.status,
        task.workspace,
        task.provider,
        task.model ?? null,
        task.createdBy ?? null,
        null,
      );
    return task;
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as TaskRow | undefined;
    return row ? this.toTask(row) : undefined;
  }

  listTasks(filter?: { projectId?: string }): Task[] {
    if (filter?.projectId) {
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC`,
        )
        .all(filter.projectId) as unknown as TaskRow[];
      return rows.map((r) => this.toTask(r));
    }
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC`)
      .all() as unknown as TaskRow[];
    return rows.map((r) => this.toTask(r));
  }

  updateTaskStatus(taskId: string, status: TaskStatus): void {
    this.db
      .prepare(`UPDATE tasks SET status = ? WHERE task_id = ?`)
      .run(status, taskId);
  }

  setTaskAgentId(taskId: string, agentId: string): void {
    if (!agentId) return;
    this.db
      .prepare(`UPDATE tasks SET agent_id = ? WHERE task_id = ?`)
      .run(agentId, taskId);
  }

  private toTask(r: TaskRow): Task {
    return {
      taskId: r.task_id,
      projectId: r.project_id || DEFAULT_PROJECT_ID,
      title: r.title,
      createdAt: r.created_at,
      status: r.status as TaskStatus,
      workspace: r.workspace,
      provider: r.provider,
      model: r.model ?? undefined,
      createdBy: r.created_by ?? undefined,
      agentId: r.agent_id || undefined,
    };
  }

  // ---- runs ----

  createRun(input: {
    runId: string;
    taskId: string;
    agentId: string;
    provider: string;
    model?: string;
  }): RunRecord {
    const run: RunRecord = {
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
      provider: input.provider,
      model: input.model,
      status: "running",
      createdAt: new Date().toISOString(),
      modelCalls: 0,
      toolCalls: 0,
    };
    this.db
      .prepare(
        `INSERT INTO runs (run_id, task_id, agent_id, provider, model, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.taskId,
        run.agentId,
        run.provider,
        run.model ?? null,
        run.status,
        run.createdAt,
      );
    return run;
  }

  updateRun(
    runId: string,
    patch: {
      status: RunStatus;
      completedAt?: string;
      durationMs?: number;
      result?: string;
      error?: string;
      usage?: TokenUsage;
      cost?: CostInfo;
      modelCalls?: number;
      toolCalls?: number;
    },
  ): void {
    const existing = this.db
      .prepare(`SELECT * FROM runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    if (!existing) return;

    this.db
      .prepare(
        `UPDATE runs SET
           status = ?,
           completed_at = ?,
           duration_ms = ?,
           result = ?,
           error = ?,
           usage_json = ?,
           cost_json = ?,
           model_calls = ?,
           tool_calls = ?
         WHERE run_id = ?`,
      )
      .run(
        patch.status,
        patch.completedAt ?? existing.completed_at,
        patch.durationMs ?? existing.duration_ms,
        patch.result ?? existing.result,
        patch.error ?? existing.error,
        patch.usage ? JSON.stringify(patch.usage) : existing.usage_json,
        patch.cost ? JSON.stringify(patch.cost) : existing.cost_json,
        patch.modelCalls ?? existing.model_calls,
        patch.toolCalls ?? existing.tool_calls,
        runId,
      );
  }

  setRunAgentId(runId: string, agentId: string): void {
    this.db
      .prepare(`UPDATE runs SET agent_id = ? WHERE run_id = ?`)
      .run(agentId, runId);
  }

  listRuns(taskId: string): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as unknown as RunRow[];
    return rows.map((r) => this.toRun(r));
  }

  private toRun(r: RunRow): RunRecord {
    return {
      runId: r.run_id,
      taskId: r.task_id,
      agentId: r.agent_id,
      provider: r.provider,
      model: r.model ?? undefined,
      status: r.status as RunStatus,
      createdAt: r.created_at,
      completedAt: r.completed_at ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      result: r.result ?? undefined,
      error: r.error ?? undefined,
      usage: r.usage_json ? (JSON.parse(r.usage_json) as TokenUsage) : undefined,
      cost: r.cost_json ? (JSON.parse(r.cost_json) as CostInfo) : undefined,
      modelCalls: r.model_calls,
      toolCalls: r.tool_calls,
    };
  }

  // ---- events ----

  appendEvent(event: AgentEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (event_id, task_id, run_id, agent_id, timestamp, event_type, payload, usage, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.taskId,
        event.runId,
        event.agentId,
        event.timestamp,
        event.eventType,
        JSON.stringify(event.payload),
        event.usage ? JSON.stringify(event.usage) : null,
        event.cost ? JSON.stringify(event.cost) : null,
      );
  }

  listEvents(
    taskId: string,
    opts: { after?: number; before?: number; limit?: number } = {},
  ): { events: AgentEvent[]; hasMore: boolean } {
    const limit = opts.limit ?? 100;

    if (opts.after != null) {
      // 增量：只拉 seq > after 的新事件（时间正序）
      const rows = this.db
        .prepare(
          `SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC`,
        )
        .all(taskId, opts.after) as unknown as EventRow[];
      return { events: rows.map((r) => this.toEvent(r)), hasMore: false };
    }

    let rows: EventRow[];
    if (opts.before != null) {
      // 更早的历史：seq < before，最近的 limit 条
      rows = this.db
        .prepare(
          `SELECT * FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(taskId, opts.before, limit) as unknown as EventRow[];
    } else {
      // 默认：只拉最近的 limit 条
      rows = this.db
        .prepare(
          `SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(taskId, limit) as unknown as EventRow[];
    }
    rows = rows.reverse(); // 转回时间正序

    const events = rows.map((r) => this.toEvent(r));
    const minSeq = this.minEventSeq(taskId);
    const oldestSeq = events.length ? (events[0].seq ?? minSeq) : minSeq;
    const hasMore = events.length > 0 && oldestSeq > minSeq;

    return { events, hasMore };
  }

  minEventSeq(taskId: string): number {
    const row = this.db
      .prepare(`SELECT MIN(seq) AS m FROM events WHERE task_id = ?`)
      .get(taskId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  maxEventSeq(taskId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS m FROM events WHERE task_id = ?`)
      .get(taskId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  private toEvent(r: EventRow): AgentEvent {
    return {
      eventId: r.event_id,
      seq: r.seq,
      taskId: r.task_id,
      runId: r.run_id,
      agentId: r.agent_id,
      timestamp: r.timestamp,
      eventType: r.event_type as EventType,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      usage: r.usage ? (JSON.parse(r.usage) as TokenUsage) : undefined,
      cost: r.cost ? (JSON.parse(r.cost) as CostInfo) : undefined,
    };
  }

  // ---- stats ----

  getTaskStats(taskId: string): TaskStats {
    const runs = this.listRuns(taskId);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costCents: number | undefined;
    let estimatedCents: number | undefined;
    let durationMs = 0;
    let modelCalls = 0;
    let toolCalls = 0;

    for (const run of runs) {
      if (run.usage) {
        inputTokens += run.usage.inputTokens || 0;
        outputTokens += run.usage.outputTokens || 0;
        cacheReadTokens += run.usage.cacheReadTokens || 0;
        cacheWriteTokens += run.usage.cacheWriteTokens || 0;
        totalTokens += run.usage.totalTokens || 0;
      }
      if (run.cost) {
        if (typeof run.cost.chargedCents === "number") {
          costCents = (costCents ?? 0) + run.cost.chargedCents;
        }
        if (typeof run.cost.estimatedCents === "number") {
          estimatedCents = (estimatedCents ?? 0) + run.cost.estimatedCents;
        }
      }
      if (run.durationMs) durationMs += run.durationMs;
      modelCalls += run.modelCalls || 0;
      toolCalls += run.toolCalls || 0;
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costCents,
      estimatedCents,
      currency: "USD",
      durationMs,
      modelCalls,
      toolCalls,
      runCount: runs.length,
    };
  }
}
