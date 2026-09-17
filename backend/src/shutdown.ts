/**
 * Restart / exit attribution.
 *
 * A gateway restart has three very different causes and, until now, the app
 * logged none of them — `server.log` just stopped and a new pid appeared:
 *
 *   1. the deployment platform announced a restart first (drain), or
 *   2. someone sent SIGTERM/SIGINT directly (`kill <pid>`, a smoke-test script
 *      with the wrong PORT, the external agent-watchdog, …), or
 *   3. the process crashed (signal 9, fatal report).
 *
 * These helpers turn that into one log line per exit plus two small files so the
 * *next* process can report how its predecessor died (also surfaced via /health).
 */
import fs from "node:fs";

/** `backend/node-exit.status`, written by scripts/supervise-node.sh. */
export type PreviousExit = {
  pid?: number;
  exitCode?: number;
  /** Signal number when the node process was killed (0 = clean exit). */
  signal?: number;
  exitedAt?: string;
};

export type ShutdownReport = {
  at: string;
  signal: string;
  pid: number;
  ppid: number;
  uptimeSec: number;
  /** true when the deployment platform had asked for a graceful restart first. */
  drainRequested: boolean;
  runningCount: number;
  queuedCount: number;
};

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  15: "SIGTERM",
};

export function signalName(signal: number | undefined): string | null {
  if (!signal) return null;
  return SIGNAL_NAMES[signal] ?? `signal ${signal}`;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Parse the `key=value` lines written by supervise-node.sh. */
export function parseExitStatus(text: string | undefined): PreviousExit | null {
  if (!text?.trim()) return null;
  const out: PreviousExit = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "pid" || key === "exitCode" || key === "signal") {
      if (!value) continue; // e.g. `signal=` — supervise-node.sh writes it empty
      const parsed = Number(value);
      // signal=0 means "exited without a signal": nothing to attribute.
      if (key === "signal" && parsed === 0) continue;
      if (Number.isFinite(parsed)) out[key] = parsed;
    } else if (key === "exitedAt" && value) {
      out.exitedAt = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function parseShutdownReport(text: string | undefined): ShutdownReport | null {
  if (!text?.trim()) return null;
  try {
    const parsed = JSON.parse(text) as ShutdownReport;
    if (!parsed || typeof parsed.signal !== "string" || typeof parsed.at !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readPreviousExit(file: string): PreviousExit | null {
  return parseExitStatus(readText(file));
}

export function readPreviousShutdown(file: string): ShutdownReport | null {
  return parseShutdownReport(readText(file));
}

/**
 * Startup line: what the *previous* process reported when it went away, so a
 * restart is visible in one place instead of "the log just stops".
 */
export function formatPreviousExit(
  previous: PreviousExit | null,
  options: { crashFlagPresent?: boolean } = {},
): string {
  const crash = options.crashFlagPresent ? " running.flag was left behind (did not exit cleanly)" : "";
  if (!previous) {
    return `[startup] previous exit: (no record)${crash}`;
  }
  const parts = [
    previous.pid != null ? `pid=${previous.pid}` : null,
    previous.exitCode != null ? `exitCode=${previous.exitCode}` : null,
  ].filter(Boolean);
  const name = signalName(previous.signal);
  if (name) {
    parts.push(`killed by ${name}`);
  } else if (previous.exitCode === 0) {
    parts.push("clean exit");
  }
  if (previous.exitedAt) parts.push(`at=${previous.exitedAt}`);
  return `[startup] previous exit: ${parts.join(" ")}${crash}`;
}

export function buildShutdownReport(
  input: {
    signal: string;
    pid: number;
    ppid: number;
    startedAt: number;
    drainRequested: boolean;
    runningCount: number;
    queuedCount: number;
  },
  now: number = Date.now(),
): ShutdownReport {
  return {
    at: new Date(now).toISOString(),
    signal: input.signal,
    pid: input.pid,
    ppid: input.ppid,
    uptimeSec: Math.max(0, Math.round((now - input.startedAt) / 1000)),
    drainRequested: input.drainRequested,
    runningCount: input.runningCount,
    queuedCount: input.queuedCount,
  };
}

export function formatShutdownLog(report: ShutdownReport): string {
  const hint = report.drainRequested
    ? "(platform asked for a graceful restart)"
    : "(no deploy drain was announced — external kill or manual restart?)";
  return (
    `[shutdown] signal=${report.signal} pid=${report.pid} ppid=${report.ppid}` +
    ` uptimeSec=${report.uptimeSec} running=${report.runningCount}` +
    ` queued=${report.queuedCount} drain=${report.drainRequested ? "yes" : "no"} ${hint}`
  );
}
