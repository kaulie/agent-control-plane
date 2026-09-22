/**
 * Process-lifetime errors that must not take down the gateway.
 *
 * Cursor SDK (`@cursor/sdk`) uses a `WritableIterable` for the agent run
 * stream. `write()` after `close()` throws `WriteIterableClosedError`. A late
 * MCP / tool / exec result can do this seconds after `run.stream()` already
 * ended; that Promise is not ours to await. The previous handler treated every
 * `unhandledRejection` as fatal (`process.exit(1)`), which is how a finished
 * turn killed the whole process (2026-09-22 crash
 * `crash-unhandledRejection-1790042179728-31636.json`).
 */

export function isBenignSdkClosedStreamError(reason: unknown): boolean {
  if (reason == null) return false;
  if (typeof reason === "string") return isClosedStreamText(reason);
  if (reason instanceof Error) {
    if (isClosedStreamName(reason.name) || isClosedStreamName(reason.constructor?.name)) {
      return true;
    }
    return isClosedStreamText(reason.message);
  }
  if (typeof reason === "object") {
    const rec = reason as { name?: unknown; message?: unknown };
    if (typeof rec.name === "string" && isClosedStreamName(rec.name)) return true;
    if (typeof rec.message === "string" && isClosedStreamText(rec.message)) return true;
  }
  return false;
}

/** True → keep serving; false → existing fatal crash path. */
export function shouldExitOnProcessError(reason: unknown): boolean {
  return !isBenignSdkClosedStreamError(reason);
}

function isClosedStreamName(name: string | undefined): boolean {
  return name === "WriteIterableClosedError";
}

function isClosedStreamText(text: string): boolean {
  return /WriteIterableClosedError|WritableIterable is closed/i.test(text);
}
