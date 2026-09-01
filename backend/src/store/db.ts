import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CostInfo,
  EventType,
  RunRecord,
  RunStatus,
  Task,
  TaskStats,
  TaskStatus,
  TokenUsage,
} from "../types.js";

interface TaskRow {
  task_id: string;
  title: string;
  created_at: string;
  status: string;
  workspace: string;
  provider: string;
  model: string | null;
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
    `);
  }

  close(): void {
    this.db.close();
  }

  /** On startup, mark any run left "running" by a previous process as errored. */
  markInterruptedRuns(): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'error', completed_at = ?, error = ? WHERE status = 'running'`,
      )
      .run(new Date().toISOString(), "interrupted (server restart)");
  }

  // ---- tasks ----

  createTask(input: {
    title: string;
    workspace: string;
    provider: string;
    model?: string;
  }): Task {
    const task: Task = {
      taskId: newId("task"),
      title: input.title,
      createdAt: new Date().toISOString(),
      status: "active",
      workspace: input.workspace,
      provider: input.provider,
      model: input.model,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, title, created_at, status, workspace, provider, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.title,
        task.createdAt,
        task.status,
        task.workspace,
        task.provider,
        task.model ?? null,
      );
    return task;
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as TaskRow | undefined;
    return row ? this.toTask(row) : undefined;
  }

  listTasks(): Task[] {
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

  private toTask(r: TaskRow): Task {
    return {
      taskId: r.task_id,
      title: r.title,
      createdAt: r.created_at,
      status: r.status as TaskStatus,
      workspace: r.workspace,
      provider: r.provider,
      model: r.model ?? undefined,
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

  listEvents(taskId: string, afterSeq?: number): AgentEvent[] {
    const rows = afterSeq
      ? (this.db
          .prepare(
            `SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC`,
          )
          .all(taskId, afterSeq) as unknown as EventRow[])
      : (this.db
          .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC`)
          .all(taskId) as unknown as EventRow[]);
    return rows.map((r) => this.toEvent(r));
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


