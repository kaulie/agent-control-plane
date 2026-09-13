/**
 * Concurrency sample range + downsampling (Agent 运行状态).
 * Run: node scripts/test-concurrency-series.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function openTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-concurrency-"));
  const dbPath = path.join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE concurrency_samples (
      t TEXT PRIMARY KEY,
      running_count INTEGER NOT NULL
    );
  `);
  return { db, dir };
}

function insert(db, t, runningCount) {
  db.prepare(
    `INSERT OR REPLACE INTO concurrency_samples (t, running_count) VALUES (?, ?)`,
  ).run(t, runningCount);
}

function listRange(db, fromIso, toIso, granularity) {
  if (granularity === "raw") {
    return db
      .prepare(
        `SELECT t, running_count AS runningCount FROM concurrency_samples
         WHERE t >= ? AND t <= ? ORDER BY t ASC`,
      )
      .all(fromIso, toIso);
  }
  const bucketExpr =
    granularity === "minute"
      ? `substr(t, 1, 16) || ':00.000Z'`
      : `substr(t, 1, 13) || ':00:00.000Z'`;
  const groupExpr =
    granularity === "minute" ? `substr(t, 1, 16)` : `substr(t, 1, 13)`;
  return db
    .prepare(
      `SELECT ${bucketExpr} AS t, MAX(running_count) AS runningCount
       FROM concurrency_samples
       WHERE t >= ? AND t <= ?
       GROUP BY ${groupExpr}
       ORDER BY t ASC`,
    )
    .all(fromIso, toIso);
}

function resolveGranularity(spanMs) {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  if (spanMs > DAY) return "hour";
  if (spanMs > HOUR) return "minute";
  return "raw";
}

{
  assert.equal(resolveGranularity(60 * 60 * 1000), "raw");
  assert.equal(resolveGranularity(60 * 60 * 1000 + 1), "minute");
  assert.equal(resolveGranularity(24 * 60 * 60 * 1000), "minute");
  assert.equal(resolveGranularity(24 * 60 * 60 * 1000 + 1), "hour");
}

{
  const { db, dir } = openTempDb();
  insert(db, "2026-09-12T10:00:00.000Z", 1);
  insert(db, "2026-09-12T10:00:15.000Z", 2);
  insert(db, "2026-09-12T10:00:30.000Z", 1);
  insert(db, "2026-09-12T10:01:00.000Z", 3);
  insert(db, "2026-09-12T11:00:00.000Z", 4);
  insert(db, "2026-09-12T12:30:00.000Z", 5);

  const raw = listRange(
    db,
    "2026-09-12T10:00:00.000Z",
    "2026-09-12T10:01:00.000Z",
    "raw",
  );
  assert.equal(raw.length, 4);
  assert.equal(raw[1].runningCount, 2);

  const byMin = listRange(
    db,
    "2026-09-12T10:00:00.000Z",
    "2026-09-12T11:00:00.000Z",
    "minute",
  );
  assert.equal(byMin.length, 3);
  assert.equal(byMin[0].t, "2026-09-12T10:00:00.000Z");
  assert.equal(byMin[0].runningCount, 2);
  assert.equal(byMin[1].runningCount, 3);
  assert.equal(byMin[2].runningCount, 4);

  const byHour = listRange(
    db,
    "2026-09-12T10:00:00.000Z",
    "2026-09-12T12:30:00.000Z",
    "hour",
  );
  assert.equal(byHour.length, 3);
  assert.equal(byHour[0].t, "2026-09-12T10:00:00.000Z");
  assert.equal(byHour[0].runningCount, 3);
  assert.equal(byHour[2].runningCount, 5);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("test-concurrency-series: ok");
