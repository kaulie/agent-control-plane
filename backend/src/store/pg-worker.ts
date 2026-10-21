/**
 * One Postgres client living on a worker thread.
 * The gateway store is synchronous (it used to be node:sqlite); the parent
 * blocks on this thread instead of rewriting every call site to async.
 */
import { parentPort, type MessagePort } from "node:worker_threads";
import pg from "pg";
import { connectWithSslFallback } from "./pg-ssl.js";
import { toPostgresPlaceholders } from "./sql-dialect.js";
import { importSqliteDatabase } from "./sqlite-cutover.js";

pg.types.setTypeParser(20, (val) => Number(val));
pg.types.setTypeParser(21, (val) => Number(val));
pg.types.setTypeParser(23, (val) => Number(val));
pg.types.setTypeParser(700, (val) => Number(val));
pg.types.setTypeParser(701, (val) => Number(val));

type Flag = Int32Array;

interface WorkerRequest {
  type: string;
  port: MessagePort;
  flag: Flag;
  sql?: string;
  params?: unknown[];
  connectionString?: string;
  sqlitePath?: string;
  finalize?: boolean;
}

let connectionString = "";
let client: pg.Client | null = null;

function reply(port: MessagePort, flag: Flag, message: unknown): void {
  port.postMessage(message);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

async function connect(): Promise<pg.Client> {
  return connectWithSslFallback(
    connectionString,
    async (config) => {
      const next = new pg.Client(config);
      next.on("error", (err: Error) => {
        console.warn(`[store] postgres connection error: ${err.message}`);
      });
      try {
        await next.connect();
      } catch (err) {
        await next.end().catch(() => {});
        throw err;
      }
      return next;
    },
    (line) => console.warn(line),
  );
}

function isDisconnect(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code: unknown }).code) : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "57P01" ||
    code === "08006" ||
    code === "08003" ||
    /connection terminated|server closed the connection|Client has encountered a connection error/i.test(
      message,
    )
  );
}

async function query(
  sql: string,
  params?: unknown[],
): Promise<{ rows: unknown[]; rowCount: number }> {
  const run = async () => {
    if (!client) client = await connect();
    const result =
      params == null ? await client.query(sql) : await client.query(sql, params);
    const results = Array.isArray(result) ? result : [result];
    const last = results[results.length - 1];
    return {
      rows: last?.rows ?? [],
      rowCount: last?.rowCount ?? 0,
    };
  };
  try {
    return await run();
  } catch (err) {
    if (!isDisconnect(err)) throw err;
    await client?.end().catch(() => {});
    client = null;
    return run();
  }
}

function fail(err: unknown): { ok: false; message: string; code: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  return { ok: false, message, code };
}

parentPort?.on("message", (msg: WorkerRequest) => {
  const { port, flag } = msg;
  void (async () => {
    try {
      if (msg.type === "init") {
        connectionString = msg.connectionString ?? "";
        if (!connectionString) throw new Error("DATABASE_URL is empty");
        client = await connect();
        reply(port, flag, { ok: true });
        return;
      }
      if (msg.type === "exec") {
        const sql = String(msg.sql ?? "").trim();
        if (/^PRAGMA\b/i.test(sql)) {
          reply(port, flag, { ok: true });
          return;
        }
        await query(sql);
        reply(port, flag, { ok: true });
        return;
      }
      if (msg.type === "query") {
        const sql = toPostgresPlaceholders(String(msg.sql ?? ""));
        const params = Array.isArray(msg.params) ? msg.params : [];
        const result = await query(sql, params);
        reply(port, flag, { ok: true, rows: result.rows, rowCount: result.rowCount });
        return;
      }
      if (msg.type === "import-sqlite") {
        if (!client) client = await connect();
        await client.query("SET statement_timeout = 0");
        await client.query("SET synchronous_commit = off");
        try {
          const summary = await importSqliteDatabase({
            query: (sql, params) => query(sql, params),
            sqlitePath: String(msg.sqlitePath ?? ""),
            finalize: msg.finalize === true,
            log: (line) => console.warn(line),
          });
          reply(port, flag, { ok: true, summary });
        } finally {
          await client.query("SET synchronous_commit = on").catch(() => {});
          await client.query("SET statement_timeout = 120000").catch(() => {});
        }
        return;
      }
      if (msg.type === "close") {
        await client?.end().catch(() => {});
        client = null;
        reply(port, flag, { ok: true });
        return;
      }
      throw new Error(`unknown postgres worker message: ${msg.type}`);
    } catch (err) {
      reply(port, flag, fail(err));
    }
  })();
});
