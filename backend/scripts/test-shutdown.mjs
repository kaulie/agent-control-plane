/**
 * Restart attribution: parsing/formatting of the exit records, and the guarantee
 * that closing the store is idempotent (a second close used to throw
 * `database is not open` from the SIGTERM path → uncaughtException crash).
 *
 * Usage: npx tsx backend/scripts/test-shutdown.mjs   (or: npm test)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildShutdownReport,
  formatPreviousExit,
  formatShutdownLog,
  parseExitStatus,
  parseShutdownReport,
  signalName,
} from "../src/shutdown.ts";
import { Store } from "../src/store/db.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

check("parseExitStatus reads supervise-node.sh format", () => {
  const parsed = parseExitStatus(
    "pid=11657\nexitCode=0\nsignal=\nexitedAt=2026-09-17 12:44:02\n",
  );
  assert.deepEqual(parsed, {
    pid: 11657,
    exitCode: 0,
    exitedAt: "2026-09-17 12:44:02",
  });
});

check("parseExitStatus keeps a signal number", () => {
  const parsed = parseExitStatus("pid=1\nexitCode=137\nsignal=9\nexitedAt=x\n");
  assert.equal(parsed?.signal, 9);
  assert.equal(parsed?.exitCode, 137);
});

check("parseExitStatus tolerates missing/garbage input", () => {
  assert.equal(parseExitStatus(undefined), null);
  assert.equal(parseExitStatus(""), null);
  assert.equal(parseExitStatus("   \n"), null);
  assert.equal(parseExitStatus("nonsense\n"), null);
});

check("signalName maps the usual killers", () => {
  assert.equal(signalName(15), "SIGTERM");
  assert.equal(signalName(9), "SIGKILL");
  assert.equal(signalName(1), "SIGHUP");
  assert.equal(signalName(12), "signal 12");
  assert.equal(signalName(0), null);
  assert.equal(signalName(undefined), null);
});

check("formatPreviousExit: clean stop", () => {
  const line = formatPreviousExit({
    pid: 11657,
    exitCode: 0,
    exitedAt: "2026-09-17 12:44:02",
  });
  assert.match(line, /^\[startup\] previous exit: pid=11657 exitCode=0 clean exit at=/);
  assert.doesNotMatch(line, /killed/);
});

check("formatPreviousExit: killed + crash flag", () => {
  const line = formatPreviousExit(
    { pid: 42, exitCode: 137, signal: 9, exitedAt: "2026-09-17 12:44:02" },
    { crashFlagPresent: true },
  );
  assert.match(line, /killed by SIGKILL/);
  assert.match(line, /running\.flag was left behind/);
});

check("formatPreviousExit: no record", () => {
  assert.match(formatPreviousExit(null), /^\[startup\] previous exit: \(no record\)$/);
});

check("buildShutdownReport computes uptime and round-trips", () => {
  const at = Date.parse("2026-09-17T04:39:02.000Z");
  const report = buildShutdownReport(
    {
      signal: "SIGTERM",
      pid: 53955,
      ppid: 53951,
      startedAt: at - 86_400_000,
      drainRequested: false,
      runningCount: 2,
      queuedCount: 0,
    },
    at,
  );
  assert.equal(report.at, "2026-09-17T04:39:02.000Z");
  assert.equal(report.uptimeSec, 86_400);
  assert.deepEqual(parseShutdownReport(JSON.stringify(report)), report);
});

check("parseShutdownReport rejects incomplete/garbage", () => {
  assert.equal(parseShutdownReport(undefined), null);
  assert.equal(parseShutdownReport("not json"), null);
  assert.equal(parseShutdownReport('{"signal":"SIGTERM"}'), null);
});

check("formatShutdownLog flags an unannounced kill", () => {
  const killed = buildShutdownReport({
    signal: "SIGTERM",
    pid: 1,
    ppid: 1,
    startedAt: 0,
    drainRequested: false,
    runningCount: 2,
    queuedCount: 0,
  });
  const line = formatShutdownLog(killed);
  assert.match(line, /drain=no/);
  assert.match(line, /no deploy drain was announced/);

  const planned = formatShutdownLog({ ...killed, drainRequested: true });
  assert.match(planned, /drain=yes/);
  assert.match(planned, /platform asked for a graceful restart/);
});

check("Store.close() is idempotent (SIGTERM may land twice)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-store-close-"));
  try {
    const store = new Store(dir);
    store.close();
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: shutdown attribution");
