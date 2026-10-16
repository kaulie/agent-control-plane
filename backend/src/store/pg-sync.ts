import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import type { SqlDatabase, SqlRunResult, SqlStatement } from "./sql-dialect.js";

interface WorkerReply {
  ok: boolean;
  message?: string;
  code?: string;
  rows?: unknown[];
  rowCount?: number;
  summary?: unknown;
}

function startWorker(): Worker {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  const isTs = self.endsWith(".ts");
  const filename = path.join(dir, isTs ? "pg-worker.ts" : "pg-worker.js");
  const execArgv = isTs
    ? ["--import", createRequire(import.meta.url).resolve("tsx")]
    : [];
  // Inherit stdio. A piped worker stdout fills up and deadlocks the thread.
  return new Worker(filename, { execArgv, stdout: true, stderr: true });
}

function roundtrip(
  worker: Worker,
  payload: Record<string, unknown>,
  timeoutMs: number,
): WorkerReply {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  worker.postMessage({ ...payload, port: port2, flag }, [port2]);
  const deadline = Date.now() + timeoutMs;
  let reply: WorkerReply | undefined;
  while (!reply) {
    const queued = receiveMessageOnPort(port1) as { message: WorkerReply } | undefined;
    if (queued) {
      reply = queued.message;
      break;
    }
    if (Atomics.load(flag, 0) === 1) {
      const late = receiveMessageOnPort(port1) as { message: WorkerReply } | undefined;
      if (late) {
        reply = late.message;
        break;
      }
    }
    if (Date.now() >= deadline) {
      port1.close();
      throw new Error("postgres worker timed out");
    }
    Atomics.wait(flag, 0, 0, 250);
  }
  port1.close();
  if (!reply.ok) {
    const err = new Error(reply.message || "postgres query failed");
    if (reply.code) (err as Error & { code?: string }).code = reply.code;
    throw err;
  }
  return reply;
}

/**
 * Synchronous Postgres handle with the same prepare/exec/close shape as node:sqlite.
 * Queries run on one worker connection; the caller blocks until each one finishes.
 */
export class PostgresSync implements SqlDatabase {
  private readonly worker: Worker;
  private closed = false;

  constructor(connectionString: string) {
    this.worker = startWorker();
    this.worker.unref();
    roundtrip(this.worker, { type: "init", connectionString }, 20_000);
  }

  exec(sql: string): void {
    this.assertOpen();
    roundtrip(this.worker, { type: "exec", sql }, 120_000);
  }

  prepare(sql: string): SqlStatement {
    this.assertOpen();
    const worker = this.worker;
    return {
      all: (...params: unknown[]) => {
        const reply = roundtrip(worker, { type: "query", sql, params }, 120_000);
        return reply.rows ?? [];
      },
      get: (...params: unknown[]) => {
        const reply = roundtrip(worker, { type: "query", sql, params }, 120_000);
        return reply.rows?.[0];
      },
      run: (...params: unknown[]): SqlRunResult => {
        const reply = roundtrip(worker, { type: "query", sql, params }, 120_000);
        const row = reply.rows?.[0];
        const seq =
          row && typeof row === "object" && row !== null && "seq" in row
            ? Number((row as { seq: unknown }).seq)
            : 0;
        return {
          changes: reply.rowCount ?? 0,
          lastInsertRowid: Number.isFinite(seq) ? seq : 0,
        };
      },
    };
  }

  /**
   * Copy the non-event tables out of a SQLite file.
   * Agent event history (`events`) is intentionally left behind.
   */
  importSqlite(sqlitePath: string, opts: { finalize: boolean }): void {
    this.assertOpen();
    const reply = roundtrip(
      this.worker,
      { type: "import-sqlite", sqlitePath, finalize: opts.finalize },
      15 * 60 * 1000,
    );
    const summary = reply.summary as
      | { skipped?: boolean; reason?: string; counts?: Record<string, number> }
      | undefined;
    if (summary?.skipped && summary.reason === "already-done") {
      console.warn("[store] sqlite cutover already recorded; leaving postgres as-is");
      return;
    }
    if (summary?.skipped) return;
    console.warn(
      `[store] sqlite cutover imported ${JSON.stringify(summary?.counts ?? {})}; events were not copied`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      roundtrip(this.worker, { type: "close" }, 10_000);
    } catch (err) {
      console.warn(
        "[store] postgres close failed:",
        err instanceof Error ? err.message : err,
      );
    }
    void this.worker.terminate();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("postgres store is closed");
  }
}
