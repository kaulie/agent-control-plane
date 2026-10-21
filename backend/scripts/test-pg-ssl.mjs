/**
 * Postgres SSL mode: omitted sslmode is libpq `prefer` (try SSL, fall back
 * when the server has none). Explicit `require` stays SSL-only.
 *
 * Usage: npx tsx scripts/test-pg-ssl.mjs
 */
import assert from "node:assert/strict";
import {
  connectWithSslFallback,
  isSslUnsupportedError,
  postgresConnectPlan,
} from "../src/store/pg-ssl.ts";

const localUrl = "postgres://web_cursor:s3cret@127.0.0.1:5432/web_cursor?";
const local = postgresConnectPlan(localUrl);
assert.equal(local.fallback, true);
assert.deepEqual(local.config.ssl, { rejectUnauthorized: false });
assert.equal(local.config.connectionString, "postgres://web_cursor:s3cret@127.0.0.1:5432/web_cursor");

const required = postgresConnectPlan(
  "postgres://web_cursor:s3cret@db.example:5432/web_cursor?sslmode=require",
);
assert.equal(required.fallback, false);
assert.deepEqual(required.config.ssl, { rejectUnauthorized: false });
assert.equal(
  required.config.connectionString,
  "postgres://web_cursor:s3cret@db.example:5432/web_cursor",
);

const preferred = postgresConnectPlan(
  "postgres://web_cursor:s3cret@db.example:5432/web_cursor?foo=1&sslmode=prefer",
);
assert.equal(preferred.fallback, true);
assert.equal(
  preferred.config.connectionString,
  "postgres://web_cursor:s3cret@db.example:5432/web_cursor?foo=1",
);

const disabled = postgresConnectPlan(
  "postgres://web_cursor:s3cret@127.0.0.1:5432/web_cursor?sslmode=disable&application_name=x",
);
assert.equal(disabled.fallback, false);
assert.equal(disabled.config.ssl, false);
assert.equal(
  disabled.config.connectionString,
  "postgres://web_cursor:s3cret@127.0.0.1:5432/web_cursor?application_name=x",
);

const verified = postgresConnectPlan(
  "postgres://web_cursor:s3cret@db.example:5432/web_cursor?sslmode=verify-full",
);
assert.equal(verified.fallback, false);
assert.deepEqual(verified.config.ssl, { rejectUnauthorized: true });

assert.equal(
  isSslUnsupportedError(new Error("The server does not support SSL connections")),
  true,
);
assert.equal(isSslUnsupportedError(new Error("password authentication failed")), false);

const sslUnsupported = new Error("The server does not support SSL connections");

const preferCalls = [];
const preferLogs = [];
const opened = await connectWithSslFallback(
  localUrl,
  async (config) => {
    preferCalls.push(config.ssl);
    if (config.ssl) throw sslUnsupported;
    return { ok: true };
  },
  (line) => preferLogs.push(line),
);
assert.deepEqual(opened, { ok: true });
assert.deepEqual(preferCalls, [{ rejectUnauthorized: false }, false]);
assert.deepEqual(preferLogs, [
  "[store] postgres server does not support SSL; connecting without it",
]);

const requireCalls = [];
await assert.rejects(
  () =>
    connectWithSslFallback(
      "postgres://web_cursor:s3cret@db.example:5432/web_cursor?sslmode=require",
      async (config) => {
        requireCalls.push(config.ssl);
        throw sslUnsupported;
      },
    ),
  /does not support SSL/,
);
assert.equal(requireCalls.length, 1);

const authCalls = [];
await assert.rejects(
  () =>
    connectWithSslFallback(localUrl, async (config) => {
      authCalls.push(config.ssl);
      throw new Error("password authentication failed for user \"web_cursor\"");
    }),
  /password authentication failed/,
);
assert.equal(authCalls.length, 1);

const plainCalls = [];
await connectWithSslFallback(
  "postgres://web_cursor:s3cret@127.0.0.1:5432/web_cursor?sslmode=disable",
  async (config) => {
    plainCalls.push(config.ssl);
    return { ok: true };
  },
);
assert.deepEqual(plainCalls, [false]);

console.log("PASS: postgres ssl prefer fallback");
