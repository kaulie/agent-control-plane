/**
 * WriteIterableClosedError must not take the gateway down.
 * Usage: npx tsx backend/scripts/test-process-errors.mjs
 */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isBenignSdkClosedStreamError,
  isCursorSdkUnavailableError,
  shouldExitOnProcessError,
} from "../src/process-errors.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

class WriteIterableClosedError extends Error {
  constructor(message = "WritableIterable is closed") {
    super(message);
    this.name = "WriteIterableClosedError";
  }
}

const closed = new WriteIterableClosedError();
assert(isBenignSdkClosedStreamError(closed) === true, "class + name");
assert(shouldExitOnProcessError(closed) === false, "closed stream is not fatal");

const named = new Error("WritableIterable is closed");
named.name = "WriteIterableClosedError";
assert(isBenignSdkClosedStreamError(named) === true, "name + message");
assert(
  isBenignSdkClosedStreamError("WriteIterableClosedError: WritableIterable is closed") ===
    true,
  "string reason from crash report",
);
assert(
  isBenignSdkClosedStreamError({
    name: "WriteIterableClosedError",
    message: "WritableIterable is closed",
  }) === true,
  "error-like object",
);

assert(isBenignSdkClosedStreamError(null) === false, "null");
assert(isBenignSdkClosedStreamError(undefined) === false, "undefined");
assert(isBenignSdkClosedStreamError(new Error("Network request failed")) === false, "other Error");
assert(shouldExitOnProcessError(new Error("boom")) === true, "real rejection still fatal");
assert(isBenignSdkClosedStreamError("ECONNRESET") === false, "other string");

function unavailable(overrides = {}) {
  const error = new Error("[unavailable] Error");
  error.name = "ConnectError";
  error.code = 14;
  error.stack = "ConnectError: [unavailable] Error\n    at y (file:///runtime/node_modules/@cursor/sdk/dist/esm/401.js:1:3111)";
  return Object.assign(error, overrides);
}

const transport = unavailable();
assert(isCursorSdkUnavailableError(transport), "observed SDK transport error");
assert(!shouldExitOnProcessError(transport, "unhandledRejection"), "SDK rejection is isolated");
assert(shouldExitOnProcessError(transport, "uncaughtException"), "uncaught transport exception remains fatal");
assert(shouldExitOnProcessError(transport), "unspecified origin remains conservative");
for (const error of [
  unavailable({ code: 13 }),
  unavailable({ code: "14" }),
  unavailable({ name: "TypeError" }),
  unavailable({ message: "application bug" }),
  unavailable({ stack: "ConnectError: [unavailable] Error\n    at app (/app/index.js:1:1)" }),
  unavailable({ stack: "ConnectError: [unavailable] Error\n    at x (/app/node_modules/other-sdk/dist/index.js:1:1)" }),
  unavailable({ stack: undefined }),
  unavailable({ stack: "message mentioning /node_modules/@cursor/sdk/dist/esm/401.js" }),
  { name: "ConnectError", code: 14, message: "[unavailable] Error", stack: transport.stack },
  "[unavailable] Error",
  new TypeError("broken invariant"),
]) {
  assert(shouldExitOnProcessError(error, "unhandledRejection"), "unrelated/ambiguous errors stay fatal");
}
assert(isCursorSdkUnavailableError(unavailable({
  stack: "ConnectError: [unavailable] Error\n    at y (C:\\app\\node_modules\\@cursor\\sdk\\dist\\cjs\\401.js:1:1)",
})), "Windows SDK stack");

const mode = process.env.PROCESS_ERROR_CHILD;
if (mode) {
  let handled = 0;
  for (const kind of ["unhandledRejection", "uncaughtException"]) {
    process.on(kind, (reason) => {
      if (shouldExitOnProcessError(reason, kind)) process.exit(2);
      handled++;
    });
  }
  const server = createServer((_req, res) => res.end("healthy"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const error = mode === "closed" ? new WriteIterableClosedError()
    : mode === "bug" ? new TypeError("broken invariant") : unavailable();
  if (mode === "uncaught") setImmediate(() => { throw error; });
  else if (mode === "unavailable") {
    const { Agent } = await import("@cursor/sdk");
    const { CursorProvider } = await import("../src/providers/cursor/index.ts");
    const originalCreate = Agent.create;
    let sends = 0;
    Agent.create = async () => ({
      agentId: "test-agent",
      close() {},
      getUsage: async () => ({}),
      send: async () => {
        const failed = ++sends === 1;
        return {
          // Simulate an SDK background rejection alongside its normal terminal error.
          async *stream() {
            if (failed) {
              void Promise.reject(error);
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          },
          wait: async () => failed
            ? { status: "error", error: { message: error.message } }
            : { status: "finished", result: "next task completed" },
        };
      },
    });
    const provider = new CursorProvider({});
    const events = [];
    const input = {
      taskId: "test-task", runId: "failed-run", agentId: "", cwd: process.cwd(),
      model: "test-model", prompt: { text: "test" }, onEvent: (event) => events.push(event),
    };
    try {
      const failed = await provider.run(input);
      assert(failed.status === "error", "upstream failure remains a failed task");
      assert(events.some((event) => event.eventType === "run_error"), "failure remains visible");
      assert(!events.some((event) => event.eventType === "run_completed"), "failed task is not successful");
      const next = await provider.run({ ...input, runId: "next-run" });
      assert(next.status === "finished", "subsequent run can finish");
      assert(sends === 2, "unavailable does not create an automatic retry loop");
    } finally {
      Agent.create = originalCreate;
      provider.dispose();
    }
  } else queueMicrotask(() => { void Promise.reject(error); });
  // Let Node emit the rejection before checking that the gateway still serves.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert(response.ok && await response.text() === "healthy", "health survives SDK failure");
  assert(handled === 1, "exactly one non-fatal error observed");
  await new Promise((resolve) => server.close(resolve));
  console.log("survived");
} else {
  const self = fileURLToPath(import.meta.url);
  for (const mode of ["closed", "unavailable", "uncaught", "bug"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", self], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, PROCESS_ERROR_CHILD: mode },
      encoding: "utf8",
      timeout: 15_000,
    });
    const fatal = mode === "uncaught" || mode === "bug";
    assert(child.status === (fatal ? 2 : 0), `${mode}: unexpected exit ${child.status}\n${child.stderr}`);
    if (!fatal) assert(child.stdout.includes("survived"), `${mode}: health check did not complete`);
  }
  console.log("PASS: process-errors (SDK rejection isolation, HTTP liveness, fatal error boundaries)");
}
