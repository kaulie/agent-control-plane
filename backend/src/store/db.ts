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
  TaskGoal,
  TaskStats,
  TaskStatus,
  TaskType,
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
import { normalizeTaskType } from "../task-types.js";
import { normalizeTaskGoal } from "../task-goals.js";
import { DEFAULT_BILLING_RULES } from "../billing/rules.js";
import { resolveBilledCost, type CostSource } from "../billing/cost.js";
import type { BillingRule } from "../billing/types.js";
import {
  sqlMarkerInList,
  sqlStateCase,
  type TimelineMarkerRow,
  type TimelineStateRow,
} from "../timeline.js";

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
  /** 1 = `agent_id` 是新建任务时预分配的（还没被 provider 真的建出会话）。 */
  agent_preallocated: number | null;
  pr_url: string | null;
  task_type: string | null;
  goal: string | null;
  description: string | null;
  last_user_input_at: string | null;
  forked_from: string | null;
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

/** `?, ?, ?` — SQLite 参数占位符（`IN (...)` 用）。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 金额保留两位小数（分的两位小数，和 usage/cost.ts 的旧口径一致）。 */
function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function isUniqueEventIdError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed: events\.event_id/i.test(err.message)
  );
}

/** `billing_rules` 行（snake_case，价格 = 本币 / 1M tokens）。 */
interface BillingRuleRow {
  rule_id: string;
  provider: string;
  model: string;
  display_name: string | null;
  currency: string;
  usd_per_unit: number;
  peak_cache_hit: number;
  peak_cache_miss: number;
  peak_output: number;
  peak_cache_write: number | null;
  offpeak_cache_hit: number;
  offpeak_cache_miss: number;
  offpeak_output: number;
  offpeak_cache_write: number | null;
  offpeak_start_min: number | null;
  offpeak_end_min: number | null;
  priority: number;
  enabled: number;
  note: string | null;
  updated_at: string;
}

function toBillingRule(r: BillingRuleRow): BillingRule {
  const window =
    r.offpeak_start_min != null && r.offpeak_end_min != null
      ? { startMinute: r.offpeak_start_min, endMinute: r.offpeak_end_min }
      : null;
  return {
    ruleId: r.rule_id,
    provider: r.provider,
    model: r.model,
    ...(r.display_name ? { displayName: r.display_name } : {}),
    currency: r.currency,
    usdPerUnit: r.usd_per_unit,
    peak: {
      cacheHit: r.peak_cache_hit,
      cacheMiss: r.peak_cache_miss,
      output: r.peak_output,
      ...(r.peak_cache_write != null ? { cacheWrite: r.peak_cache_write } : {}),
    },
    offpeak: {
      cacheHit: r.offpeak_cache_hit,
      cacheMiss: r.offpeak_cache_miss,
      output: r.offpeak_output,
      ...(r.offpeak_cache_write != null ? { cacheWrite: r.offpeak_cache_write } : {}),
    },
    offpeakWindow: window,
    priority: r.priority,
    enabled: r.enabled !== 0,
    ...(r.note ? { note: r.note } : {}),
    updatedAt: r.updated_at,
  };
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
    if (!taskCols.some((c) => c.name === "agent_preallocated")) {
      // 预分配标记：新建任务时 agent id 由网关生成（= 工作区目录名 `agent-<agentid>`），
      // 那时它还不是活的会话。历史任务没有这个标记 → 0（老行为：resume 老会话）。
      this.db.exec(
        `ALTER TABLE tasks ADD COLUMN agent_preallocated INTEGER NOT NULL DEFAULT 0`,
      );
    }
    if (!taskCols.some((c) => c.name === "task_type")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    }
    if (!taskCols.some((c) => c.name === "pr_url")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
    }
    if (!taskCols.some((c) => c.name === "goal")) {
      // 任务目标（合入主分支 / 合入并部署）。历史任务为 NULL = 没有目标，
      // 保持老行为（开完 PR 停），所以这里**不做** backfill。
      this.db.exec(`ALTER TABLE tasks ADD COLUMN goal TEXT`);
    }
    if (!taskCols.some((c) => c.name === "description")) {
      // 任务描述（需求原文）：新建时必填；老任务为 NULL（面板会提示补上）。
      this.db.exec(`ALTER TABLE tasks ADD COLUMN description TEXT`);
    }
    if (!taskCols.some((c) => c.name === "context_digest")) {
      // 模型生成的会话摘要（默认关闭；开了以后按水位缓存，见 gateway.contextDigestFor）。
      this.db.exec(`ALTER TABLE tasks ADD COLUMN context_digest TEXT`);
      this.db.exec(`ALTER TABLE tasks ADD COLUMN context_digest_at TEXT`);
      this.db.exec(`ALTER TABLE tasks ADD COLUMN context_digest_seq INTEGER`);
    }
    if (!taskCols.some((c) => c.name === "forked_from")) {
      // fork 新 task 时记来源；老库自动补列（透明化：页面能显示"fork 自 #xxx"）。
      this.db.exec(`ALTER TABLE tasks ADD COLUMN forked_from TEXT`);
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
      , seeded_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_successions_task
        ON agent_successions(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_successions_to
        ON agent_successions(to_agent_id);
    `);

    // 透明化（PR-5）：succession 带过去的 seed 体量（token 估算）——
    // 以前只记条数，看不出"切模式把 1M 上下文搬进新会话"。
    const successionCols = this.db
      .prepare(`PRAGMA table_info(agent_successions)`)
      .all() as unknown as Array<{ name: string }>;
    if (!successionCols.some((c) => c.name === "seeded_tokens")) {
      this.db.exec(`ALTER TABLE agent_successions ADD COLUMN seeded_tokens INTEGER`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS concurrency_samples (
        t TEXT PRIMARY KEY,
        running_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_concurrency_samples_t
        ON concurrency_samples(t);
    `);

    // 计费规则表（billing 模块的唯一数据源）：模型价目 + 峰谷时段规则。
    // 价格单位 = 规则本币 / 1M tokens；错峰窗口用 UTC 分钟 [start, end)，跨 0 点 start > end。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_rules (
        rule_id             TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        model               TEXT NOT NULL,
        display_name        TEXT,
        currency            TEXT NOT NULL DEFAULT 'USD',
        usd_per_unit        REAL NOT NULL DEFAULT 1,
        peak_cache_hit      REAL NOT NULL,
        peak_cache_miss     REAL NOT NULL,
        peak_output         REAL NOT NULL,
        peak_cache_write    REAL,
        offpeak_cache_hit   REAL NOT NULL,
        offpeak_cache_miss  REAL NOT NULL,
        offpeak_output      REAL NOT NULL,
        offpeak_cache_write REAL,
        offpeak_start_min   INTEGER,
        offpeak_end_min     INTEGER,
        priority            INTEGER NOT NULL DEFAULT 0,
        enabled             INTEGER NOT NULL DEFAULT 1,
        note                TEXT,
        updated_at          TEXT NOT NULL
      );
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

    this.seedBillingRules(now);
  }

  /**
   * 内置计费规则只在缺失时补种（`INSERT OR IGNORE`）：运维改过的行不被覆盖，
   * 想在重启后仍停用某行就置 `enabled = 0`，不要删。
   */
  private seedBillingRules(now: string): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO billing_rules (
        rule_id, provider, model, display_name, currency, usd_per_unit,
        peak_cache_hit, peak_cache_miss, peak_output, peak_cache_write,
        offpeak_cache_hit, offpeak_cache_miss, offpeak_output, offpeak_cache_write,
        offpeak_start_min, offpeak_end_min, priority, enabled, note, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const rule of DEFAULT_BILLING_RULES) {
      insert.run(
        rule.ruleId,
        rule.provider,
        rule.model,
        rule.displayName ?? null,
        rule.currency,
        rule.usdPerUnit,
        rule.peak.cacheHit,
        rule.peak.cacheMiss,
        rule.peak.output,
        rule.peak.cacheWrite ?? null,
        rule.offpeak.cacheHit,
        rule.offpeak.cacheMiss,
        rule.offpeak.output,
        rule.offpeak.cacheWrite ?? null,
        rule.offpeakWindow?.startMinute ?? null,
        rule.offpeakWindow?.endMinute ?? null,
        rule.priority,
        rule.enabled ? 1 : 0,
        rule.note ?? null,
        now,
      );
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

  // ---- billing rules（计费模块的数据源） ----

  /** 全部计费规则（含停用行；排序稳定，便于页面直接展示）。 */
  listBillingRules(): BillingRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM billing_rules
         ORDER BY provider ASC, model ASC, rule_id ASC`,
      )
      .all() as unknown as BillingRuleRow[];
    return rows.map(toBillingRule);
  }

  getBillingRule(ruleId: string): BillingRule | undefined {
    const row = this.db
      .prepare(`SELECT * FROM billing_rules WHERE rule_id = ?`)
      .get(ruleId) as BillingRuleRow | undefined;
    return row ? toBillingRule(row) : undefined;
  }

  /** 新增或整体覆盖一条规则（`ruleId` 为主键）。 */
  upsertBillingRule(rule: BillingRule): BillingRule {
    this.db
      .prepare(
        `INSERT INTO billing_rules (
           rule_id, provider, model, display_name, currency, usd_per_unit,
           peak_cache_hit, peak_cache_miss, peak_output, peak_cache_write,
           offpeak_cache_hit, offpeak_cache_miss, offpeak_output, offpeak_cache_write,
           offpeak_start_min, offpeak_end_min, priority, enabled, note, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           display_name = excluded.display_name,
           currency = excluded.currency,
           usd_per_unit = excluded.usd_per_unit,
           peak_cache_hit = excluded.peak_cache_hit,
           peak_cache_miss = excluded.peak_cache_miss,
           peak_output = excluded.peak_output,
           peak_cache_write = excluded.peak_cache_write,
           offpeak_cache_hit = excluded.offpeak_cache_hit,
           offpeak_cache_miss = excluded.offpeak_cache_miss,
           offpeak_output = excluded.offpeak_output,
           offpeak_cache_write = excluded.offpeak_cache_write,
           offpeak_start_min = excluded.offpeak_start_min,
           offpeak_end_min = excluded.offpeak_end_min,
           priority = excluded.priority,
           enabled = excluded.enabled,
           note = excluded.note,
           updated_at = excluded.updated_at`,
      )
      .run(
        rule.ruleId,
        rule.provider,
        rule.model,
        rule.displayName ?? null,
        rule.currency,
        rule.usdPerUnit,
        rule.peak.cacheHit,
        rule.peak.cacheMiss,
        rule.peak.output,
        rule.peak.cacheWrite ?? null,
        rule.offpeak.cacheHit,
        rule.offpeak.cacheMiss,
        rule.offpeak.output,
        rule.offpeak.cacheWrite ?? null,
        rule.offpeakWindow?.startMinute ?? null,
        rule.offpeakWindow?.endMinute ?? null,
        rule.priority,
        rule.enabled ? 1 : 0,
        rule.note ?? null,
        rule.updatedAt,
      );
    return this.getBillingRule(rule.ruleId) as BillingRule;
  }

  deleteBillingRule(ruleId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM billing_rules WHERE rule_id = ?`)
      .run(ruleId);
    return Number(result.changes) > 0;
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
    /** 任务描述（需求原文）。新建入口必填；内部调用（watchdog 等）可空。 */
    description?: string;
    /** 任务类型标签；缺省 `general`（= 老行为）。 */
    taskType?: TaskType;
    /** 交付目标；缺省 = 没有目标（老行为：开完 PR 停）。 */
    goal?: TaskGoal;
    /** Optional pre-allocated id (used when workspace path embeds taskId). */
    taskId?: string;
    /**
     * 预分配的 agent id（新建任务时由网关生成）。有值 = 落库为 `agent_id` 并标记
     * `agent_preallocated`：工作区目录名就是这个 id，首个 run 用它开新会话。
     */
    agentId?: string;
    /** 这个 task 是从哪个 task fork 来的（上下文将满时的分流）。 */
    forkedFrom?: string;
  }): Task {
    if (!this.getProject(input.projectId)) {
      throw new Error(`project ${input.projectId} not found`);
    }
    const now = new Date().toISOString();
    const description = input.description?.trim();
    const goal = normalizeTaskGoal(input.goal);
    const preallocatedAgentId = input.agentId?.trim();
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
      ...(preallocatedAgentId
        ? { agentId: preallocatedAgentId, agentPreallocated: true }
        : {}),
      taskType: normalizeTaskType(input.taskType),
      ...(goal ? { goal } : {}),
      ...(description ? { description } : {}),
      lastUserInputAt: now,
      ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, project_id, title, created_at, status, workspace, provider, model, created_by, agent_id, agent_preallocated, task_type, goal, description, last_user_input_at, forked_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.agentId?.trim() || null,
        preallocatedAgentId ? 1 : 0,
        task.taskType,
        task.goal ?? null,
        task.description ?? null,
        task.lastUserInputAt,
        task.forkedFrom ?? null,
      );
    return task;
  }

  /** 从这个 task fork 出去的 task id（列表页显示"已 fork → #xxx"）。 */
  listForkedTaskIds(taskId: string): string[] {
    const rows = this.db
      .prepare(`SELECT task_id FROM tasks WHERE forked_from = ? ORDER BY created_at ASC`)
      .all(taskId) as unknown as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
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

  /**
   * 清掉「agent id 是预分配的」标记：provider 已经真的建出会话了，
   * 之后这次 run 的 `agent_id` 就是可 resume 的会话句柄。
   */
  clearTaskAgentPreallocation(taskId: string): void {
    this.db
      .prepare(`UPDATE tasks SET agent_preallocated = 0 WHERE task_id = ?`)
      .run(taskId);
  }

  // ---- agent successions (explicit agent id lineage) ----

  insertAgentSuccession(row: AgentSuccession): void {
    this.db
      .prepare(
        `INSERT INTO agent_successions (
           succession_id, task_id, run_id, provider,
           from_agent_id, to_agent_id, reason, from_mode, to_mode,
           seeded_messages, seeded_tokens, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.seededTokens ?? null,
        row.createdAt,
      );
  }

  /** 这个 task 上模型生成的会话摘要（含水位：`seq` = 生成时的最新事件序号）。 */
  getTaskDigest(taskId: string): { digest: string; at: string; seq: number | null } | undefined {
    const row = this.db
      .prepare(`SELECT context_digest, context_digest_at, context_digest_seq FROM tasks WHERE task_id = ?`)
      .get(taskId) as
      | { context_digest: string | null; context_digest_at: string | null; context_digest_seq: number | null }
      | undefined;
    if (!row?.context_digest) return undefined;
    return {
      digest: row.context_digest,
      at: row.context_digest_at ?? "",
      seq: row.context_digest_seq ?? null,
    };
  }

  setTaskDigest(taskId: string, digest: string, at: string, seq: number | null): void {
    this.db
      .prepare(
        `UPDATE tasks SET context_digest = ?, context_digest_at = ?, context_digest_seq = ? WHERE task_id = ?`,
      )
      .run(digest, at, seq, taskId);
  }

  /** 这个 task 的最新事件序号（digest 水位用；没有事件返回 0）。 */
  latestEventSeq(taskId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS seq FROM events WHERE task_id = ?`)
      .get(taskId) as { seq: number | null } | undefined;
    return Number(row?.seq ?? 0) || 0;
  }

  /** `agent_successions` 的列名（诊断 / 测试用：确认老库补上了 seeded_tokens）。 */
  agentSuccessionColumns(): string[] {
    const rows = this.db
      .prepare(`PRAGMA table_info(agent_successions)`)
      .all() as unknown as Array<{ name: string }>;
    return rows.map((r) => r.name);
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
      seeded_tokens: number | null;
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
      ...(r.seeded_tokens != null ? { seededTokens: r.seeded_tokens } : {}),
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

  /**
   * 修改任务意图（标题 / 类型 / 目标 / 描述）——「理解随对话变清晰」时用户就地修正。
   *
   * 语义：`undefined` = 不动这个字段；`description` 传空串/NULL 视为**清空**，
   * 由调用方（gateway）负责「描述不允许清空」这条业务规则，store 只做落库。
   */
  updateTaskIntent(
    taskId: string,
    patch: {
      title?: string;
      taskType?: TaskType;
      goal?: TaskGoal | null;
      description?: string | null;
    },
  ): Task | undefined {
    const current = this.getTask(taskId);
    if (!current) return undefined;
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.taskType !== undefined) {
      sets.push("task_type = ?");
      values.push(normalizeTaskType(patch.taskType));
    }
    if (patch.goal !== undefined) {
      sets.push("goal = ?");
      // 传 null / 未知值 = 清掉目标（回到老行为），不是回落到默认目标。
      values.push(normalizeTaskGoal(patch.goal) ?? null);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      values.push(patch.description?.trim() ? patch.description.trim() : null);
    }
    if (!sets.length) return current;
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`)
      .run(...(values as never[]), taskId);
    return this.getTask(taskId);
  }

  private toTask(r: TaskRow): Task {
    const prUrl = r.pr_url?.trim();
    const description = r.description?.trim();
    const goal = normalizeTaskGoal(r.goal);
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
      // 预分配标记只对「还没有活会话」的新任务为真；老任务读到 NULL/0 → 不带这个字段。
      ...(r.agent_preallocated ? { agentPreallocated: true } : {}),
      ...(prUrl ? { prUrl } : {}),
      // 历史脏值（未知类型）一律读成 general，避免 UI 出现空标签。
      taskType: normalizeTaskType(r.task_type),
      // 目标没有默认值：历史 / 脏值一律读成「没设目标」（老行为）。
      ...(goal ? { goal } : {}),
      ...(description ? { description } : {}),
      lastUserInputAt: r.last_user_input_at || r.created_at,
      ...(r.forked_from ? { forkedFrom: r.forked_from } : {}),
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
    // 计费模块（billing_rules）算出来的主口径 + SDK 上报的对比口径，分开累计。
    let billedUsdCents = 0;
    let hasBilled = false;
    let billedAmount = 0;
    // 本币金额只在「全部命中的规则同一个币种」时才给（混币种就别假装能相加）。
    const billingCurrencies = new Set<string>();
    const costSources: Record<CostSource, number> = { rule: 0, reported: 0, estimate: 0 };
    let chargedCents: number | undefined;
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
        const billing = run.cost.billing;
        if (billing) {
          billedAmount += billing.amount;
          billingCurrencies.add(billing.currency);
        }
        // 主口径（= 实际成本）= resolveBilledCost：计费表 > provider/SDK 上报 > 旧估算。
        // 没有规则时它就是上报值，所以页面上「Cost」与「SDK cost」显示同一个数。
        const resolved = resolveBilledCost(run.cost);
        if (resolved) {
          billedUsdCents += resolved.cents;
          hasBilled = true;
          costSources[resolved.source] += 1;
        }
        if (typeof run.cost.chargedCents === "number") {
          chargedCents = (chargedCents ?? 0) + run.cost.chargedCents;
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
      ...(hasBilled ? { costCents: roundCents(billedUsdCents) } : {}),
      ...(billingCurrencies.size === 1
        ? {
            billedAmount: roundCents(billedAmount),
            billedCurrency: [...billingCurrencies][0],
          }
        : {}),
      ...(hasBilled ? { costSources: { ...costSources } } : {}),
      ...(chargedCents != null ? { chargedCents: roundCents(chargedCents) } : {}),
      ...(estimatedCents != null
        ? { estimatedCents: roundCents(estimatedCents) }
        : {}),
      currency: "USD",
      durationMs,
      modelCalls,
      toolCalls,
      runCount: runs.length,
    };
  }

  /**
   * 最近若干轮 run 的 usage 采样，供上下文体量显示（口径见 context/size.ts）。
   *
   * ⚠️ 每条采样是**该 run 内的累计 prompt tokens**（cline 的 usage 事件语义），
   * 不是单次请求体量：单次 prompt = 相邻两条的差（`buildContextSize` 负责折算）。
   * cursor 的 usage 是 agent 生命周期累计 → context 模块会判为不可用。
   */
  listContextUsageSamples(
    taskId: string,
    opts?: { runLimit?: number },
  ): {
    samples: Array<{ runId: string; at: string; tokens: number }>;
    modelByRun: Record<string, string | undefined>;
    latestModel?: string;
  } {
    const runLimit = Math.max(1, Math.min(50, opts?.runLimit ?? 12));
    const runRows = this.db
      .prepare(
        `SELECT run_id, model, cost_json FROM runs
         WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(taskId, runLimit) as unknown as Array<{
      run_id: string;
      model: string | null;
      cost_json: string | null;
    }>;
    if (!runRows.length) return { samples: [], modelByRun: {} };

    const modelByRun: Record<string, string | undefined> = {};
    for (const row of runRows) {
      // 老 run 的 model 列可能是 NULL（自动选模型），模型挂在 cost_json.model 上。
      let model = row.model?.trim() || undefined;
      if (!model && row.cost_json) {
        try {
          const parsed = JSON.parse(row.cost_json) as { model?: string };
          model = parsed.model?.trim() || undefined;
        } catch {
          model = undefined;
        }
      }
      modelByRun[row.run_id] = model;
    }

    const ids = runRows.map((r) => r.run_id);
    const rows = this.db
      .prepare(
        `SELECT run_id, timestamp, usage FROM events
         WHERE task_id = ? AND usage IS NOT NULL AND run_id IN (${placeholders(ids.length)})
         ORDER BY seq ASC`,
      )
      .all(taskId, ...ids) as unknown as Array<{
      run_id: string;
      timestamp: string;
      usage: string | null;
    }>;

    const samples: Array<{ runId: string; at: string; tokens: number }> = [];
    for (const row of rows) {
      if (!row.usage) continue;
      let tokens = 0;
      try {
        tokens = Number((JSON.parse(row.usage) as { inputTokens?: number }).inputTokens) || 0;
      } catch {
        continue;
      }
      if (tokens <= 0) continue;
      samples.push({ runId: row.run_id, at: row.timestamp, tokens });
    }

    const latestModel = modelByRun[runRows[0]!.run_id];
    return { samples, modelByRun, ...(latestModel ? { latestModel } : {}) };
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
   * Every run row, oldest first, with the fields the agent board / timeline
   * aggregate (tokens per run, wall-clock duration, activity).
   * Grouping/merging stays in the gateway so `tokenVolume` is applied once.
   *
   * `agentId` is `""` for legacy runs written before the agent was recorded.
   * Those still count towards their **task** rollup (so the board's task totals
   * match `/api/tasks/:taskId`); they just cannot form an agent row.
   */
  listAgentRunSamples(): AgentRunSample[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, task_id, agent_id, provider, model, status,
                created_at, completed_at, duration_ms, usage_json,
                model_calls, tool_calls
         FROM runs
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
   * 单个 agent 在给定 task 集合里的最新事件时间（时间线「最近活跃」用；走
   * `idx_events_agent_time (task_id, agent_id, timestamp)`，不受查询窗口影响）。
   */
  maxAgentEventAt(input: { taskIds: string[]; agentId: string }): string | undefined {
    const taskIds = input.taskIds.filter((t) => t);
    if (!taskIds.length || !input.agentId) return undefined;
    const placeholders = taskIds.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT MAX(timestamp) AS last_at FROM events
         WHERE task_id IN (${placeholders}) AND agent_id = ?`,
      )
      .get(...taskIds, input.agentId) as unknown as { last_at: string | null } | undefined;
    return row?.last_at ?? undefined;
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

  /**
   * Agent 时间线（`GET /api/agents/:agentId/timeline`）的状态切换点。
   *
   * 一个 agent 的事件可能有几十万条，逐条返回会卡住网关事件循环，所以只取
   * 「状态组的首/末事件」：用窗口函数算出前后状态，仅保留 state 与相邻不同的行
   * （一组最多 2 行）。命中 `idx_events_agent_time (task_id, agent_id, timestamp)`。
   */
  listAgentTimelineStateRows(input: {
    taskIds: string[];
    agentId: string;
    fromIso: string;
    toIso: string;
  }): TimelineStateRow[] {
    if (input.taskIds.length === 0) return [];
    const params = [...input.taskIds, input.agentId, input.fromIso, input.toIso];
    const rows = this.db
      .prepare(
        `WITH scoped AS (
           SELECT seq, timestamp, event_type, run_id,
                  ${sqlStateCase("event_type")} AS state
           FROM events
           WHERE task_id IN (${placeholders(input.taskIds.length)})
             AND agent_id = ?
             AND timestamp >= ? AND timestamp <= ?
         ), windowed AS (
           SELECT seq, timestamp, event_type, run_id, state,
                  LAG(state) OVER (ORDER BY timestamp, seq) AS prev_state,
                  LEAD(state) OVER (ORDER BY timestamp, seq) AS next_state
           FROM scoped
         )
         SELECT timestamp, event_type, run_id, state, prev_state, next_state
         FROM windowed
         WHERE prev_state IS NULL OR next_state IS NULL
            OR state <> prev_state OR state <> next_state
         ORDER BY timestamp ASC, seq ASC`,
      )
      .all(...params) as unknown as Array<{
      timestamp: string;
      event_type: string;
      run_id: string;
      state: string;
      prev_state: string | null;
      next_state: string | null;
    }>;
    return rows.map((r) => ({
      timestamp: r.timestamp,
      eventType: r.event_type,
      runId: r.run_id ?? "",
      state: r.state as TimelineStateRow["state"],
      isStart: r.prev_state == null || r.prev_state !== r.state,
      isEnd: r.next_state == null || r.next_state !== r.state,
    }));
  }

  /** Agent 时间线的瞬时事件行（用户输入 / run 起止 / agent 替换）。 */
  listAgentTimelineMarkerRows(input: {
    taskIds: string[];
    agentId: string;
    fromIso: string;
    toIso: string;
  }): TimelineMarkerRow[] {
    if (input.taskIds.length === 0) return [];
    const params = [...input.taskIds, input.agentId, input.fromIso, input.toIso];
    const rows = this.db
      .prepare(
        `SELECT timestamp, event_type, run_id, payload
         FROM events
         WHERE task_id IN (${placeholders(input.taskIds.length)})
           AND agent_id = ?
           AND timestamp >= ? AND timestamp <= ?
           AND ${sqlMarkerInList("event_type")}
         ORDER BY timestamp ASC, seq ASC`,
      )
      .all(...params) as unknown as Array<{
      timestamp: string;
      event_type: string;
      run_id: string;
      payload: string;
    }>;
    return rows.map((r) => ({
      timestamp: r.timestamp,
      eventType: r.event_type,
      runId: r.run_id ?? "",
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  /** 窗口内该 agent 的原始事件按类型计数（时间线 totals 用）。 */
  countAgentEventsByType(input: {
    taskIds: string[];
    agentId: string;
    fromIso: string;
    toIso: string;
  }): Record<string, number> {
    if (input.taskIds.length === 0) return {};
    const rows = this.db
      .prepare(
        `SELECT event_type, COUNT(*) AS c
         FROM events
         WHERE task_id IN (${placeholders(input.taskIds.length)})
           AND agent_id = ?
           AND timestamp >= ? AND timestamp <= ?
         GROUP BY event_type`,
      )
      .all(...input.taskIds, input.agentId, input.fromIso, input.toIso) as unknown as Array<{
      event_type: string;
      c: number;
    }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.event_type] = Number(r.c) || 0;
    return counts;
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
      ...(r.seeded_tokens != null ? { seededTokens: Number(r.seeded_tokens) } : {}),
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
