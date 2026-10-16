/**
 * Copy a SQLite web_cursor.db into the Postgres database named by DATABASE_URL.
 *
 * Agent event history (`events`) is not copied. Postgres keeps an empty events
 * table and starts its own sequence. This script does not set the cutover
 * marker; the service does that on first boot when WEB_CURSOR_SQLITE_CUTOVER=1,
 * so rows written to SQLite after this snapshot are still picked up
 * (still excluding events).
 *
 * Usage (repo root):
 *   DATABASE_URL=postgres://... npx tsx backend/scripts/import-sqlite.mjs --sqlite=/path/to/web_cursor.db
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store/db.ts";

const sqliteArg = process.argv.find((arg) => arg.startsWith("--sqlite="));
const sqlitePath = sqliteArg ? sqliteArg.slice("--sqlite=".length) : "";
const finalize = process.argv.includes("--finalize");

if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!sqlitePath || !fs.existsSync(sqlitePath)) {
  console.error(
    "用法：DATABASE_URL=postgres://... npx tsx backend/scripts/import-sqlite.mjs --sqlite=<web_cursor.db> [--finalize]",
  );
  process.exit(1);
}

delete process.env.WEB_CURSOR_SQLITE_CUTOVER;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-sqlite-import-"));
const store = new Store(dir);
try {
  store.importSqlite(sqlitePath, { finalize });
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  finalize
    ? "imported; cutover marker set; events were not copied"
    : "imported; cutover marker not set; events were not copied",
);
