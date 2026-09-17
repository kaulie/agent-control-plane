import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentRunSample,
  AgentSuccession,
  AgentSuccessionReason,
  AppSettings,
  CostInfo,
  DepartmentConfig,
  EventType,
  Project,
  RunRecord,
  RunStatus,
  Task,
  TaskStats,
  TaskStatus,
  TokenUsage,
  UsageRunSample,
} from "../types.js";
import {
  normalizeDepartment,
  parseSettings,
  patchSettings,
  serializeSettings,
} from "../settings.js";
import { tokenVolume } from "../usage/tokens.js";

export const DEFAULT_PROJECT_ID = "project-default";
export const DEFAULT_PROJECT_NAME = "Default";

export const SYSTEM_OPS_PROJECT_ID = "project-system-ops";
export const SYSTEM_OPS_PROJECT_NAME = "系统运维";
export const WATCHDOG_USER_ID = "watchdog";
export const WATCHDOG_USER_NAME = "Watchdog";

interface ProjectRow {
  project_id: string;
  name: string;
  workspace_root: string | null;
  git_repo_url: string | null;
  settings_json: string | null;
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
  pr_url: string | null;
  task_type: string | null;
  last_user_input_at: string | null;
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

/**
 * Compact unique id. Previously sliced UUID to 8 hex chars (32 bits), which
 * collides once `events.event_id` grows into the hundreds of thousands
 * (birthday bound ~77k at 50%). 16 hex chars is 64 bits — safe at this scale
 * and a different length than legacy `evt-xxxxxxxx` rows, so new ids cannot
 * collide with the existing table.
 */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function isUniqueEventIdError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed: events\.event_id/i.test(err.message)
  );
}

export class Store {
  private db: DatabaseSync;
  /** Guard for close(): shutdown may run twice (two signals, crash path). */
  private closed = false;

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
        project_id     TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        workspace_root TEXT,
        git_repo_url   TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        user_id   TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at    TEXT NOT NULL
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
    if (!taskCols.some((c) => c.name === "task_type")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    }
    if (!taskCols.some((c) => c.name === "pr_url")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
    }
    if (!taskCols.some((c) => c.name === "last_user_input_at")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN last_user_input_at TEXT`);
      // Backfill: latest user_message event, else created_at.
      this.db.exec(`
        UPDATE tasks
        SET last_user_input_at = COALESCE(
          (
            SELECT MAX(e.timestamp)
            FROM events e
            WHERE e.task_id = tasks.task_id
              AND e.event_type = 'user_message'
          ),
          created_at
        )
        WHERE last_user_input_at IS NULL
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_successions (
        succession_id    TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        run_id           TEXT NOT NULL,
        provider         TEXT NOT NULL,
        from_agent_id    TEXT NOT NULL,
        to_agent_id      TEXT NOT NULL,
        reason           TEXT NOT NULL,
        from_mode        TEXT NOT NULL,
        to_mode          TEXT NOT NULL,
        seeded_messages  INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_successions_task
        ON agent_successions(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_successions_to
        ON agent_successions(to_agent_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS concurrency_samples (
        t TEXT PRIMARY KEY,
        running_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_concurrency_samples_t
        ON concurrency_samples(t);
    `);

    this.db.exec(
      `UPDATE tasks SET task_type = 'general' WHERE task_type IS NULL OR task_type = ''`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`,
    );
    // Agent board（`GET /api/agents`）要按 (task, agent) 取「最后活跃时间」：
    // 没有这个索引时 `MAX(timestamp) GROUP BY task_id, agent_id` 要全表扫 events
    // （实测 47 万行 ≈ 0.65s，会卡住网关事件循环；建索引后 ≈ 0.13s）。
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_agent_time
         ON events(task_id, agent_id, timestamp)`,
    );

    const projectCols = this.db
      .prepare(`PRAGMA table_info(projects)`)
      .all() as unknown as Array<{ name: string }>;
    if (!projectCols.some((c) => c.name === "workspace_root")) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN workspace_root TEXT`);
    }
    if (!projectCols.some((c) => c.name === "git_repo_url")) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN git_repo_url TEXT`);
    }
    if (!projectCols.some((c) => c.name === "settings_json")) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN settings_json TEXT`);
    }

    const appSettingsExists = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'`,
      )
      .get() as { name: string } | undefined;
    if (!appSettingsExists) {
      this.db.exec(`
        CREATE TABLE app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          settings_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );
      `);
    }
    const globalRow = this.db
      .prepare(`SELECT id FROM app_settings WHERE id = 1`)
      .get() as { id: number } | undefined;
    if (!globalRow) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO app_settings (id, settings_json, updated_at) VALUES (1, '{}', ?)`,
        )
        .run(now);
    }

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

  /**
   * Close the SQLite handle. Idempotent and non-throwing on purpose: this runs
   * from the SIGTERM/SIGINT shutdown path, where a second (or already closed)
   * handle used to raise `Error: database is not open` as an uncaughtException —
   * turning a clean restart into a crash report plus a bogus crash-analysis task.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      console.warn("[store] close failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * On startup, mark any run left "running" by a previous process as cancelled,
   * append a terminal timeline event, and return orphans for SDK cleanup plus
   * finalized rows so the gateway can push them to reconnecting browsers.
   */
  markInterruptedRuns(): {
    orphans: Array<{ agentId: string; cwd: string; provider?: string }>;
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
                t.workspace AS workspace,
                t.provider AS provider
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
      provider: string | null;
    }>;

    const now = new Date().toISOString();
    const finalized: Array<{
      taskId: string;
      runId: string;
      event: AgentEvent;
    }> = [];
    const orphanKeys = new Set<string>();
    const orphans: Array<{ agentId: string; cwd: string; provider?: string }> =
      [];

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
        const provider = row.provider?.trim() || undefined;
        const key = `${provider ?? ""}::${row.agent_id}::${row.workspace}`;
        if (!orphanKeys.has(key)) {
          orphanKeys.add(key);
          orphans.push({
            agentId: row.agent_id,
            cwd: row.workspace,
            ...(provider ? { provider } : {}),
          });
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

  createProject(
    name: string,
    options?: { gitRepoUrl?: string; department?: DepartmentConfig },
  ): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("project name is required");
    const now = new Date().toISOString();
    const gitRepoUrl = options?.gitRepoUrl?.trim() || null;
    // 新建项目时可同时带上「所属部门」；它与项目设置共用 settings_json，
    // 这里一次性写入，避免“项目已建但部门丢了”的中间态。
    const department = normalizeDepartment(options?.department);
    const project: Project = {
      projectId: newId("project"),
      name: trimmed,
      ...(gitRepoUrl ? { gitRepoUrl } : {}),
      ...(department ? { department } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (project_id, name, workspace_root, git_repo_url, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.projectId,
        project.name,
        null,
        gitRepoUrl,
        serializeSettings(department ? { department } : {}),
        project.createdAt,
        project.updatedAt,
      );
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
    const existing = this.getProject(projectId);
    if (!existing) return undefined;

    const updates: string[] = [];
    const values: Array<string | null> = [];
    let next = { ...existing };

    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new Error("project name is required");
      updates.push("name = ?");
      values.push(trimmed);
      next = { ...next, name: trimmed };
    }

    if (input.gitRepoUrl !== undefined) {
      const url = input.gitRepoUrl?.trim() || null;
      updates.push("git_repo_url = ?");
      values.push(url);
      if (url) {
        next = { ...next, gitRepoUrl: url };
      } else {
        const { gitRepoUrl: _removed, ...rest } = next;
        next = rest;
      }
    }

    if (!updates.length) return existing;

    const updatedAt = new Date().toISOString();
    updates.push("updated_at = ?");
    values.push(updatedAt);
    values.push(projectId);

    this.db
      .prepare(`UPDATE projects SET ${updates.join(", ")} WHERE project_id = ?`)
      .run(...values);

    return { ...next, updatedAt };
  }

  getProjectSettings(projectId: string): AppSettings | undefined {
    const row = this.db
      .prepare(`SELECT settings_json FROM projects WHERE project_id = ?`)
      .get(projectId) as { settings_json: string | null } | undefined;
    if (!row) return undefined;
    return parseSettings(row.settings_json);
  }

  updateProjectSettings(
    projectId: string,
    patch: AppSettings,
  ): AppSettings | undefined {
    const project = this.getProject(projectId);
    if (!project) return undefined;
    const current = this.getProjectSettings(projectId) ?? {};
    const next = patchSettings(current, patch);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE projects SET settings_json = ?, updated_at = ? WHERE project_id = ?`,
      )
      .run(serializeSettings(next), updatedAt, projectId);
    return next;
  }

  getGlobalSettings(): AppSettings {
    const row = this.db
      .prepare(`SELECT settings_json FROM app_settings WHERE id = 1`)
      .get() as { settings_json: string } | undefined;
    return parseSettings(row?.settings_json);
  }

  updateGlobalSettings(patch: AppSettings): AppSettings {
    const current = this.getGlobalSettings();
    const next = patchSettings(current, patch);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`UPDATE app_settings SET settings_json = ?, updated_at = ? WHERE id = 1`)
      .run(serializeSettings(next), updatedAt);
    return next;
  }

  private toProject(r: ProjectRow): Project {
    const gitRepoUrl = r.git_repo_url?.trim();
    // 部门住在 settings_json 里：列表/详情一起带上，左栏才能显示“项目所在的部门”。
    const department = normalizeDepartment(parseSettings(r.settings_json).department);
    return {
      projectId: r.project_id,
      name: r.name,
      ...(gitRepoUrl ? { gitRepoUrl } : {}),
      ...(department ? { department } : {}),
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
    const now = new Date().toISOString();
    const task: Task = {
      taskId: input.taskId?.trim() || newId("task"),
      projectId: input.projectId,
      title: input.title,
      createdAt: now,
      status: "active",
      workspace: input.workspace,
      provider: input.provider,
      model: input.model,
      createdBy: input.createdBy,
      taskType: "general",
      lastUserInputAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, project_id, title, created_at, status, workspace, provider, model, created_by, agent_id, task_type, last_user_input_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.taskType,
        task.lastUserInputAt,
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
          `SELECT * FROM tasks
           WHERE project_id = ?
           ORDER BY COALESCE(last_user_input_at, created_at) DESC, created_at DESC`,
        )
        .all(filter.projectId) as unknown as TaskRow[];
      return rows.map((r) => this.toTask(r));
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         ORDER BY COALESCE(last_user_input_at, created_at) DESC, created_at DESC`,
      )
      .all() as unknown as TaskRow[];
    return rows.map((r) => this.toTask(r));
  }

  touchTaskLastUserInput(
    taskId: string,
    at: string = new Date().toISOString(),
  ): Task | undefined {
    if (!this.getTask(taskId)) return undefined;
    this.db
      .prepare(`UPDATE tasks SET last_user_input_at = ? WHERE task_id = ?`)
      .run(at, taskId);
    return this.getTask(taskId);
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

  // ---- agent successions (explicit agent id lineage) ----

  insertAgentSuccession(row: AgentSuccession): void {
    this.db
      .prepare(
        `INSERT INTO agent_successions (
           succession_id, task_id, run_id, provider,
           from_agent_id, to_agent_id, reason, from_mode, to_mode,
           seeded_messages, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.successionId,
        row.taskId,
        row.runId,
        row.provider,
        row.fromAgentId,
        row.toAgentId,
        row.reason,
        row.fromMode,
        row.toMode,
        row.seededMessages,
        row.createdAt,
      );
  }

  listAgentSuccessions(taskId: string): AgentSuccession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_successions WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as unknown as Array<{
      succession_id: string;
      task_id: string;
      run_id: string;
      provider: string;
      from_agent_id: string;
      to_agent_id: string;
      reason: string;
      from_mode: string;
      to_mode: string;
      seeded_messages: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      successionId: r.succession_id,
      taskId: r.task_id,
      runId: r.run_id,
      provider: r.provider,
      fromAgentId: r.from_agent_id,
      toAgentId: r.to_agent_id,
      reason: r.reason as AgentSuccessionReason,
      fromMode: r.from_mode,
      toMode: r.to_mode,
      seededMessages: r.seeded_messages,
      createdAt: r.created_at,
    }));
  }

  updateTaskPrUrl(taskId: string, prUrl: string | null): Task | undefined {
    if (!this.getTask(taskId)) return undefined;
    const url = prUrl?.trim() || null;
    this.db
      .prepare(`UPDATE tasks SET pr_url = ? WHERE task_id = ?`)
      .run(url, taskId);
    return this.getTask(taskId);
  }

  private toTask(r: TaskRow): Task {
    const prUrl = r.pr_url?.trim();
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
      ...(prUrl ? { prUrl } : {}),
      taskType: (r.task_type as Task["taskType"]) || "general",
      lastUserInputAt: r.last_user_input_at || r.created_at,
    };
  }

  // ---- runs ----

  createRun(input: {
    runId: string;
    taskId: string;
    agentId: string;
    provider: string;
    model?: string;
    status?: RunStatus;
  }): RunRecord {
    const run: RunRecord = {
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
      provider: input.provider,
      model: input.model,
      status: input.status ?? "running",
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

  /** Queued runs across all tasks, oldest first (for startup recovery). */
  listAllQueuedRuns(): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC`,
      )
      .all() as unknown as RunRow[];
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
    const insert = this.db.prepare(
      `INSERT INTO events (event_id, task_id, run_id, agent_id, timestamp, event_type, payload, usage, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Retry with a fresh id if we still hit a rare collision (or a caller
    // reused an eventId). Mutate event.eventId so WS publish matches the row.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = insert.run(
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
        // Attach AUTOINCREMENT seq before WS publish — without it the UI treats
        // live events as seq=0 and sorts them above historically loaded rows.
        event.seq = Number(result.lastInsertRowid);
        return;
      } catch (err) {
        if (!isUniqueEventIdError(err) || attempt === 4) throw err;
        event.eventId = newId("evt");
      }
    }
  }

  listEvents(
    taskId: string,
    opts: { after?: number; before?: number; limit?: number } = {},
  ): { events: AgentEvent[]; hasMore: boolean } {
    const limit = opts.limit ?? 100;

    if (opts.after != null) {
      // 增量：只拉 seq > after 的新事件（时间正序）。必须带 LIMIT，
      // 避免 after=0 时把整段历史一次性打给前端把时间线拼乱。
      const incLimit = Math.min(Math.max(limit, 1), 2000);
      const rows = this.db
        .prepare(
          `SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        )
        .all(taskId, opts.after, incLimit) as unknown as EventRow[];
      const events = rows.map((r) => this.toEvent(r));
      const maxSeq = this.maxEventSeq(taskId);
      const last = events.length ? (events[events.length - 1].seq ?? 0) : opts.after;
      const hasMore = events.length >= incLimit && last < maxSeq;
      return { events, hasMore };
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
        totalTokens += tokenVolume(run.usage, run.provider);
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

  /**
   * Finished runs that carry a usage payload, joined with their task row.
   * Used by the cross-task token-usage series endpoint.
   */
  listUsageRunSamples(filter?: { projectId?: string }): UsageRunSample[] {
    const rows = this.db
      .prepare(
        `SELECT r.run_id, r.task_id, r.provider, r.model, r.created_at,
                r.completed_at, r.usage_json, r.status, t.project_id
         FROM runs r
         JOIN tasks t ON t.task_id = r.task_id
         WHERE r.usage_json IS NOT NULL
           AND (?1 IS NULL OR t.project_id = ?1)
         ORDER BY r.created_at ASC`,
      )
      .all(filter?.projectId?.trim() || null) as unknown as Array<{
      run_id: string;
      task_id: string;
      provider: string;
      model: string | null;
      created_at: string;
      completed_at: string | null;
      usage_json: string;
      status: string;
      project_id: string;
    }>;
    return rows.map((r) => ({
      runId: r.run_id,
      taskId: r.task_id,
      projectId: r.project_id,
      provider: r.provider,
      ...(r.model ? { model: r.model } : {}),
      createdAt: r.created_at,
      ...(r.completed_at ? { completedAt: r.completed_at } : {}),
      usage: JSON.parse(r.usage_json) as TokenUsage,
    }));
  }

  /**
   * Every run of a task that carries an agent id, with the fields the agent
   * board aggregates (tokens per run, wall-clock duration, activity).
   * Grouping/merging stays in the gateway so `tokenVolume` is applied once.
   */
  listAgentRunSamples(): AgentRunSample[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, task_id, agent_id, provider, model, status,
                created_at, completed_at, duration_ms, usage_json,
                model_calls, tool_calls
         FROM runs
         WHERE agent_id IS NOT NULL
           AND agent_id != ''
         ORDER BY created_at ASC`,
      )
      .all() as unknown as Array<{
      run_id: string;
      task_id: string;
      agent_id: string;
      provider: string;
      model: string | null;
      status: string;
      created_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      usage_json: string | null;
      model_calls: number;
      tool_calls: number;
    }>;
    return rows.map((r) => ({
      runId: r.run_id,
      taskId: r.task_id,
      agentId: r.agent_id,
      provider: r.provider,
      ...(r.model?.trim() ? { model: r.model.trim() } : {}),
      status: r.status as RunStatus,
      createdAt: r.created_at,
      ...(r.completed_at ? { completedAt: r.completed_at } : {}),
      ...(r.duration_ms != null ? { durationMs: r.duration_ms } : {}),
      ...(r.usage_json
        ? { usage: JSON.parse(r.usage_json) as TokenUsage }
        : {}),
      modelCalls: r.model_calls,
      toolCalls: r.tool_calls,
    }));
  }

  /**
   * Newest event per (task, agent) — the real "最后活跃时间" (a run row is only
   * written when the run finishes, events stream while it is still running).
   */
  listAgentLastEventAt(): Array<{
    taskId: string;
    agentId: string;
    lastAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT task_id, agent_id, MAX(timestamp) AS last_at
         FROM events
         WHERE agent_id IS NOT NULL AND agent_id != ''
         GROUP BY task_id, agent_id`,
      )
      .all() as unknown as Array<{
      task_id: string;
      agent_id: string;
      last_at: string;
    }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      agentId: r.agent_id,
      lastAt: r.last_at,
    }));
  }

  /** Every succession, oldest first (agent board marks replaced agents). */
  listAllAgentSuccessions(): AgentSuccession[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_successions ORDER BY created_at ASC`)
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      successionId: String(r.succession_id),
      taskId: String(r.task_id),
      runId: String(r.run_id),
      provider: String(r.provider),
      fromAgentId: String(r.from_agent_id),
      toAgentId: String(r.to_agent_id),
      reason: r.reason as AgentSuccessionReason,
      fromMode: String(r.from_mode),
      toMode: String(r.to_mode),
      seededMessages: Number(r.seeded_messages) || 0,
      createdAt: String(r.created_at),
    }));
  }

  /** Persist one gateway concurrency sample (ops monitor chart). Never pruned. */
  insertConcurrencySample(t: string, runningCount: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO concurrency_samples (t, running_count)
         VALUES (?, ?)`,
      )
      .run(t, runningCount);
  }

  /** Earliest sample timestamp, or null if the table is empty. */
  getEarliestConcurrencySampleAt(): string | null {
    const row = this.db
      .prepare(`SELECT t FROM concurrency_samples ORDER BY t ASC LIMIT 1`)
      .get() as { t: string } | undefined;
    return row?.t ?? null;
  }

  /** Samples at/after cutoff ISO timestamp, oldest first. */
  listConcurrencySamplesSince(
    cutoffIso: string,
  ): Array<{ t: string; runningCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT t, running_count FROM concurrency_samples
         WHERE t >= ?
         ORDER BY t ASC`,
      )
      .all(cutoffIso) as unknown as Array<{ t: string; running_count: number }>;
    return rows.map((r) => ({
      t: r.t,
      runningCount: r.running_count,
    }));
  }

  /**
   * Samples in [fromIso, toIso], oldest first.
   * `minute` / `hour` buckets use MAX(running_count) so peaks remain visible.
   */
  listConcurrencySamplesRange(
    fromIso: string,
    toIso: string,
    granularity: "raw" | "minute" | "hour" = "raw",
  ): Array<{ t: string; runningCount: number }> {
    if (granularity === "raw") {
      const rows = this.db
        .prepare(
          `SELECT t, running_count FROM concurrency_samples
           WHERE t >= ? AND t <= ?
           ORDER BY t ASC`,
        )
        .all(fromIso, toIso) as unknown as Array<{
        t: string;
        running_count: number;
      }>;
      return rows.map((r) => ({ t: r.t, runningCount: r.running_count }));
    }

    // ISO `2026-09-12T15:38:06.058Z` → minute `…T15:38:00.000Z`, hour `…T15:00:00.000Z`
    const bucketExpr =
      granularity === "minute"
        ? `substr(t, 1, 16) || ':00.000Z'`
        : `substr(t, 1, 13) || ':00:00.000Z'`;
    const groupExpr =
      granularity === "minute" ? `substr(t, 1, 16)` : `substr(t, 1, 13)`;

    const rows = this.db
      .prepare(
        `SELECT ${bucketExpr} AS t, MAX(running_count) AS running_count
         FROM concurrency_samples
         WHERE t >= ? AND t <= ?
         GROUP BY ${groupExpr}
         ORDER BY t ASC`,
      )
      .all(fromIso, toIso) as unknown as Array<{
      t: string;
      running_count: number;
    }>;
    return rows.map((r) => ({ t: r.t, runningCount: r.running_count }));
  }
}
