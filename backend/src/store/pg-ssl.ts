import type { ClientConfig } from "pg";

export interface PostgresConnectPlan {
  config: ClientConfig;
  /** Retry once without SSL when the server rejects the SSL request. */
  fallback: boolean;
}

/**
 * Translate a libpq URL into the config node-pg actually uses.
 *
 * node-pg lets `sslmode` in the URL overwrite an explicit `ssl` object, and
 * then treats `require` as "verify the server cert". libpq `require` only
 * encrypts. The hosted database presents a self-signed cert, so `require` and
 * `prefer` keep that libpq meaning (`rejectUnauthorized: false`). The mode is
 * stripped out of the URL so node-pg cannot turn verification back on.
 *
 * An omitted `sslmode` follows libpq and means `prefer`: try SSL, and if the
 * server does not support it, connect without SSL. Treating that omission as
 * `require` made startup fail against a local Postgres with SSL turned off
 * (`The server does not support SSL connections`).
 */
export function postgresConnectPlan(url: string): PostgresConnectPlan {
  const mode = /(?:\?|&)sslmode=([^&]*)/i.exec(url)?.[1]?.toLowerCase() ?? "prefer";
  const connectionString = url
    .replace(/([?&])sslmode=[^&]*/i, "$1")
    .replace(/[?&]$/, "")
    .replace(/\?&/, "?");
  const base: ClientConfig = {
    connectionString,
    application_name: "web-cursor",
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  };
  if (mode === "disable" || mode === "allow") {
    return { config: { ...base, ssl: false }, fallback: false };
  }
  if (mode === "verify-ca" || mode === "verify-full") {
    return {
      config: { ...base, ssl: { rejectUnauthorized: true } },
      fallback: false,
    };
  }
  return {
    config: { ...base, ssl: { rejectUnauthorized: false } },
    fallback: mode === "prefer",
  };
}

export function isSslUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /does not support SSL/i.test(message);
}

export async function connectWithSslFallback<T>(
  url: string,
  open: (config: ClientConfig) => Promise<T>,
  log: (line: string) => void = () => {},
): Promise<T> {
  const plan = postgresConnectPlan(url);
  try {
    return await open(plan.config);
  } catch (err) {
    if (!plan.fallback || !plan.config.ssl || !isSslUnsupportedError(err)) throw err;
    log("[store] postgres server does not support SSL; connecting without it");
    return await open({ ...plan.config, ssl: false });
  }
}
