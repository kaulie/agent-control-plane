import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

/**
 * Tables copied from the on-disk SQLite file into Postgres.
 * `events` is deliberately absent: agent event history stays in SQLite and
 * is not migrated. Postgres starts a fresh `events` sequence.
 */
const TABLE_ORDER = [
  "projects",
  "users",
  "app_settings",
  "billing_rules",
  "provider_accounts",
  "tasks",
  "runs",
  "agent_successions",
  "concurrency_samples",
] as const;

const PRIMARY_KEYS: Record<(typeof TABLE_ORDER)[number], string> = {
  projects: "project_id",
  users: "user_id",
  app_settings: "id",
  billing_rules: "rule_id",
  provider_accounts: "account_id",
  tasks: "task_id",
  runs: "run_id",
  agent_successions: "succession_id",
  concurrency_samples: "t",
};

export interface CutoverQuery {
  (
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface CutoverSummary {
  skipped: boolean;
  /** Why nothing was copied. Absent when a copy ran. */
  reason?: "missing-file" | "already-done";
  counts: Record<string, number>;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`unexpected SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function sqliteColumns(sqlite: DatabaseSync, table: string): string[] {
  quoteIdent(table);
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

async function postgresColumns(query: CutoverQuery, table: string): Promise<string[]> {
  const result = await query(
    `SELECT column_name AS name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map((row) => String((row as { name: string }).name));
}

async function upsertBatch(
  query: CutoverQuery,
  table: string,
  pk: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples: string[] = [];
  let n = 1;
  for (const row of rows) {
    const slots: string[] = [];
    for (const column of columns) {
      slots.push(`$${n++}`);
      const value = row[column];
      values.push(value === undefined ? null : value);
    }
    tuples.push(`(${slots.join(", ")})`);
  }
  const updates = columns
    .filter((column) => column !== pk)
    .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`);
  const conflict =
    updates.length > 0
      ? `ON CONFLICT (${quoteIdent(pk)}) DO UPDATE SET ${updates.join(", ")}`
      : `ON CONFLICT (${quoteIdent(pk)}) DO NOTHING`;
  await query(
    `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")})
     VALUES ${tuples.join(", ")}
     ${conflict}`,
    values,
  );
}

function takeBatch(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  start: number,
): { batch: Array<Record<string, unknown>>; next: number } {
  const batch: Array<Record<string, unknown>> = [];
  let bytes = 0;
  let i = start;
  while (i < rows.length && batch.length < 200 && bytes < 1_500_000) {
    const row = rows[i];
    if (!row) break;
    let rowBytes = 0;
    for (const column of columns) {
      const value = row[column];
      if (typeof value === "string") rowBytes += value.length;
      else rowBytes += 16;
    }
    if (batch.length > 0 && bytes + rowBytes > 1_500_000) break;
    batch.push(row);
    bytes += rowBytes;
    i += 1;
  }
  return { batch, next: i };
}

async function copyTable(
  sqlite: DatabaseSync,
  query: CutoverQuery,
  table: (typeof TABLE_ORDER)[number],
  log: (line: string) => void,
): Promise<number> {
  const sqliteNames = new Set(sqliteColumns(sqlite, table));
  const columns = (await postgresColumns(query, table)).filter((name) =>
    sqliteNames.has(name),
  );
  const pk = PRIMARY_KEYS[table];
  if (!columns.includes(pk)) {
    throw new Error(`${table} is missing primary key ${pk} on one side of the copy`);
  }

  let rows: Array<Record<string, unknown>>;
  if (table === "concurrency_samples") {
    const max = await query(`SELECT MAX(t) AS m FROM concurrency_samples`);
    const marker = (max.rows[0] as { m: string | null } | undefined)?.m;
    const selected = columns.map(quoteIdent).join(", ");
    rows = (
      marker
        ? sqlite
            .prepare(
              `SELECT ${selected} FROM concurrency_samples WHERE t >= ? ORDER BY t ASC`,
            )
            .all(marker)
        : sqlite.prepare(`SELECT ${selected} FROM concurrency_samples ORDER BY t ASC`).all()
    ) as Array<Record<string, unknown>>;
  } else {
    const selected = columns.map(quoteIdent).join(", ");
    rows = sqlite.prepare(`SELECT ${selected} FROM ${quoteIdent(table)}`).all() as Array<
      Record<string, unknown>
    >;
  }

  for (let i = 0; i < rows.length; ) {
    const { batch, next } = takeBatch(rows, columns, i);
    await upsertBatch(query, table, pk, columns, batch);
    i = next;
    if (rows.length > 1000 && (i === rows.length || i % 5000 < (next - i))) {
      log(`[sqlite-cutover] ${table} ${Math.min(i, rows.length)}/${rows.length}`);
    }
  }

  const counted = await query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`);
  const pgCount = Number((counted.rows[0] as { n: number }).n) || 0;
  const sqliteCount = Number(
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number })
      .n,
  );
  if (pgCount < sqliteCount) {
    throw new Error(
      `${table} copy is short: postgres has ${pgCount}, sqlite has ${sqliteCount}`,
    );
  }
  log(`[sqlite-cutover] ${table} postgres=${pgCount} sqlite=${sqliteCount}`);
  return pgCount;
}

export async function importSqliteDatabase(opts: {
  query: CutoverQuery;
  sqlitePath: string;
  finalize: boolean;
  log?: (line: string) => void;
}): Promise<CutoverSummary> {
  const log = opts.log ?? (() => {});
  if (!opts.sqlitePath || !fs.existsSync(opts.sqlitePath)) {
    log(`[sqlite-cutover] no sqlite file at ${opts.sqlitePath}; nothing to copy`);
    return { skipped: true, reason: "missing-file", counts: {} };
  }

  const done = await opts.query(
    `SELECT value FROM store_meta WHERE key = 'sqlite_cutover_done'`,
  );
  if (done.rows.length > 0) {
    return { skipped: true, reason: "already-done", counts: {} };
  }

  let sqlite: DatabaseSync;
  try {
    sqlite = new DatabaseSync(opts.sqlitePath, { readOnly: true });
  } catch (err) {
    log(
      `[sqlite-cutover] read-only open failed (${err instanceof Error ? err.message : String(err)}); opening read-write`,
    );
    sqlite = new DatabaseSync(opts.sqlitePath);
  }
  const counts: Record<string, number> = {};
  try {
    const present = new Set(
      (
        sqlite
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    if (present.has("events")) {
      const eventCount = (
        sqlite.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }
      ).n;
      log(
        `[sqlite-cutover] skipping events (${eventCount} agent event rows stay in sqlite)`,
      );
    }
    for (const table of TABLE_ORDER) {
      if (!present.has(table)) {
        log(`[sqlite-cutover] sqlite has no ${table}; skipping`);
        continue;
      }
      counts[table] = await copyTable(sqlite, opts.query, table, log);
    }
  } finally {
    sqlite.close();
  }

  if (opts.finalize) {
    await opts.query(
      `INSERT INTO store_meta (key, value)
       VALUES ('sqlite_cutover_done', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [new Date().toISOString()],
    );
    log("[sqlite-cutover] marked sqlite_cutover_done (events were not copied)");
  }
  return { skipped: false, counts };
}
