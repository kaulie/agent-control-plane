import type { FastifyInstance } from "fastify";

/**
 * UI-version guard for frontend writes.
 *
 * The SPA sends the build it is running (its baked `__APP_VERSION__`) in the
 * `x-ui-version` header with every request. Before the gateway accepts a write
 * it compares that value with the version this project currently serves
 * (on-disk `VERSION`, i.e. the same value `/health` advertises). A stale page —
 * left open across a deploy, or served from a cache — can therefore no longer
 * persist edits that were written against a UI which no longer exists: the
 * write is rejected with `ui-version-mismatch` and the SPA tells the user to
 * refresh first.
 *
 * Deliberately NOT guarded (they are not frontend writes):
 *  - every non-write method (GET/HEAD/OPTIONS);
 *  - anything outside `/api/` (static assets, `/health`, `/ws`);
 *  - `/api/ops/*` — the deployment platform's graceful-restart contract, called
 *    by that separate service, which has no UI version.
 */

/** Request header carrying the UI build the browser is running. */
export const UI_VERSION_HEADER = "x-ui-version";

/** Machine-readable reason; the SPA turns it into "请先刷新页面". */
export const UI_VERSION_MISMATCH = "ui-version-mismatch";

/** Methods that change state and therefore must prove a current UI. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Written by other services, never by the browser (see module docstring). */
const NON_UI_WRITE_PREFIXES = ["/api/ops/"];

export interface UiVersionGuardOptions {
  /** Version this project currently serves (disk VERSION → APP_VERSION). */
  serverVersion: () => string;
}

/** True when this request is a frontend write that must be version-checked. */
export function isGuardedWrite(method: string, url: string): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  const path = url.split("?")[0] ?? url;
  if (!path.startsWith("/api/")) return false;
  return !NON_UI_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Registers the guard as an `onRequest` hook so no route handler runs for a
 * stale page (every current — and future — write is covered by construction).
 */
export function registerUiVersionGuard(
  app: FastifyInstance,
  opts: UiVersionGuardOptions,
): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isGuardedWrite(req.method, req.url ?? "")) return;

    const serverVersion = opts.serverVersion();
    const header = req.headers[UI_VERSION_HEADER];
    const clientVersion = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
    if (clientVersion === serverVersion) return;

    // Missing header = a page built before this guard existed (stale by
    // definition) or a script; both must refresh/upgrade, so reject as well.
    const missing = clientVersion.length === 0;
    req.log.warn(
      {
        method: req.method,
        url: req.url,
        clientVersion: clientVersion || null,
        serverVersion,
      },
      "rejected frontend write: UI version mismatch",
    );
    return reply.code(missing ? 428 : 409).send({
      code: UI_VERSION_MISMATCH,
      clientVersion: clientVersion || null,
      serverVersion,
      mustRefresh: true,
      error: missing
        ? `missing ${UI_VERSION_HEADER} header: cannot confirm this page matches the running project version (${serverVersion}); refresh the page and retry`
        : `page version ${clientVersion} does not match the running project version (${serverVersion}); refresh the page and retry`,
    });
  });
}
