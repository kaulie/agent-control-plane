/**
 * WriteIterableClosedError must not take the gateway down.
 * Usage: npx tsx backend/scripts/test-process-errors.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isBenignSdkClosedStreamError,
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

if (process.env.PROCESS_ERROR_CHILD === "1") {
  const onLate = (reason) => {
    if (!shouldExitOnProcessError(reason)) {
      process.stdout.write("ignored\n");
      process.exit(0);
    }
    process.exit(2);
  };
  process.on("unhandledRejection", onLate);
  process.on("uncaughtException", onLate);
  queueMicrotask(() => Promise.reject(new WriteIterableClosedError()));
} else {
  const self = fileURLToPath(import.meta.url);
  const child = spawnSync("npx", ["tsx", self], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PROCESS_ERROR_CHILD: "1" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert(child.status === 0, `child should survive closed-stream rejection, got ${child.status}\n${child.stderr}`);
  assert((child.stdout || "").includes("ignored"), `child should log ignored, got ${child.stdout}`);
  console.log("PASS: process-errors (WriteIterableClosedError is not fatal)");
}
