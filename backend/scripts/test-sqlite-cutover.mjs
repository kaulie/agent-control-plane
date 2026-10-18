/**
 * SQLite cutover of concurrency_samples must backfill history that sits
 * behind Postgres's newest timestamp. A `t >= MAX(t)` filter skips those
 * rows, the full-count check throws, and sqlite_cutover_done is never set.
 *
 * Usage: npx tsx scripts/test-sqlite-cutover.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importSqliteDatabase } from "../src/store/sqlite-cutover.ts";

function writeSqlite(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-cutover-"));
  const sqlitePath = path.join(dir, "web_cursor.db");
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec(
    `CREATE TABLE concurrency_samples (
       t TEXT PRIMARY KEY,
       running_count INTEGER NOT NULL
     )`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO concurrency_samples (t, running_count) VALUES (?, ?)`,
  );
  for (const [t, runningCount] of rows) insert.run(t, runningCount);
  sqlite.close();
  return { dir, sqlitePath };
}

function fakePostgres(initial, opts = {}) {
  const samples = new Map(initial);
  const sqlLog = [];
  const query = async (sql, params = []) => {
    sqlLog.push(sql);
    if (sql.includes("sqlite_cutover_done")) return { rows: [], rowCount: 0 };
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ name: "t" }, { name: "running_count" }], rowCount: 2 };
    }
    if (sql.includes(" AS k ")) {
      return {
        rows: [...samples.keys()].map((k) => ({ k })),
        rowCount: samples.size,
      };
    }
    if (sql.includes('INSERT INTO "concurrency_samples"')) {
      if (!opts.dropInserts) {
        for (let i = 0; i < params.length; i += 2) {
          samples.set(String(params[i]), params[i + 1]);
        }
      }
      return { rows: [], rowCount: params.length / 2 };
    }
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ n: samples.size }], rowCount: 1 };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return { samples, query, sqlLog };
}

const history = [
  ["2026-01-01T00:00:00.000Z", 1],
  ["2026-01-02T00:00:00.000Z", 2],
  ["2026-06-01T00:00:00.000Z", 3],
];

{
  const { dir, sqlitePath } = writeSqlite(history);
  const pg = fakePostgres([
    ["2026-06-01T00:00:00.000Z", 9],
    ["2026-07-01T00:00:00.000Z", 4],
  ]);
  const summary = await importSqliteDatabase({
    query: pg.query,
    sqlitePath,
    finalize: false,
  });
  assert.equal(summary.skipped, false);
  assert.equal(summary.counts.concurrency_samples, 4);
  assert.equal(pg.samples.get("2026-01-01T00:00:00.000Z"), 1);
  assert.equal(pg.samples.get("2026-01-02T00:00:00.000Z"), 2);
  assert.equal(pg.samples.get("2026-06-01T00:00:00.000Z"), 9);
  assert.equal(pg.samples.get("2026-07-01T00:00:00.000Z"), 4);
  assert.equal(
    pg.sqlLog.some((sql) => sql.includes("MAX(t)")),
    false,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, sqlitePath } = writeSqlite(history);
  const pg = fakePostgres([]);
  const summary = await importSqliteDatabase({
    query: pg.query,
    sqlitePath,
    finalize: false,
  });
  assert.equal(summary.counts.concurrency_samples, 3);
  assert.equal(pg.samples.size, 3);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, sqlitePath } = writeSqlite(history);
  const pg = fakePostgres([], { dropInserts: true });
  await assert.rejects(
    () => importSqliteDatabase({ query: pg.query, sqlitePath, finalize: false }),
    /concurrency_samples copy is short: postgres has 0, sqlite has 3/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("PASS: sqlite cutover backfills concurrency history");
