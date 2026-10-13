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

/**
 * Cursor SDK 1.0.30 can leak a transport rejection alongside its run error.
 * Only recognize the observed Connect unavailable error from an SDK frame;
 * matching message text alone would hide unrelated application failures.
 */
export function isCursorSdkUnavailableError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const error = reason as Error & { code?: unknown };
  return (
    error.name === "ConnectError" &&
    error.code === 14 &&
    /^\[unavailable\](?:\s|$)/.test(error.message) &&
    /(?:^|\n)\s+at [^\n]*[\\/]node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(error.stack ?? "")
  );
}

/** False keeps serving; true preserves the fatal crash path. */
export function shouldExitOnProcessError(
  reason: unknown,
  kind: "uncaughtException" | "unhandledRejection" = "uncaughtException",
): boolean {
  if (isBenignSdkClosedStreamError(reason)) return false;
  return !(kind === "unhandledRejection" && isCursorSdkUnavailableError(reason));
}

function isClosedStreamName(name: string | undefined): boolean {
  return name === "WriteIterableClosedError";
}

function isClosedStreamText(text: string): boolean {
  return /WriteIterableClosedError|WritableIterable is closed/i.test(text);
}
