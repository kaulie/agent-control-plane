/**
 * Fixed-account login: password comes from LOGIN_PASSWORD, username from
 * LOGIN_USERNAME (default admin). Non-loopback /api and /ws require the
 * session cookie; loopback and /health do not.
 *
 * Usage: npx tsx backend/scripts/test-login-auth.mjs   (or: npm test)
 */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { isGuardedWrite } from "../src/http/ui-version.ts";
import {
  createLoginGuard,
  registerLoginRoutes,
} from "../src/http/login-gate.ts";
import {
  LOGIN_COOKIE,
  LoginAttemptLimiter,
  allowsAnonymous,
  fixedCredentialsMatch,
  isLoopbackAddress,
  requestIsAuthenticated,
  resolveLoginAuth,
  signSession,
  verifySession,
} from "../src/login-auth.ts";

const auth = resolveLoginAuth({
  LOGIN_USERNAME: "ada",
  LOGIN_PASSWORD: "s3cret-pass",
});

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL ${name}: ${err.message}`);
      throw err;
    });
}

await check("password unset disables the gate", () => {
  assert.equal(resolveLoginAuth({}).enabled, false);
  assert.equal(resolveLoginAuth({ LOGIN_PASSWORD: "  " }).enabled, false);
});

await check("username defaults to admin", () => {
  const gate = resolveLoginAuth({ LOGIN_PASSWORD: "pw" });
  assert.equal(gate.enabled, true);
  assert.equal(gate.username, "admin");
  assert.equal(gate.sessionSecret, "pw");
});

await check("explicit username and session secret win", () => {
  assert.equal(auth.username, "ada");
  assert.equal(auth.sessionSecret, "s3cret-pass");
  const custom = resolveLoginAuth({
    LOGIN_USERNAME: "ada",
    LOGIN_PASSWORD: "pw",
    LOGIN_SESSION_SECRET: "other",
  });
  assert.equal(custom.sessionSecret, "other");
});

await check("credential match is exact and does not leak which field failed", () => {
  assert.equal(fixedCredentialsMatch(auth, "ada", "s3cret-pass"), true);
  assert.equal(fixedCredentialsMatch(auth, "Ada", "s3cret-pass"), false);
  assert.equal(fixedCredentialsMatch(auth, "ada", "nope"), false);
  assert.equal(fixedCredentialsMatch(auth, "", ""), false);
});

await check("session cookie round-trips and rejects tamper or expiry", () => {
  const exp = 5_000;
  const token = signSession("ada", exp, auth.sessionSecret);
  assert.equal(verifySession(token, exp - 1, auth.sessionSecret), "ada");
  assert.equal(verifySession(token, exp, auth.sessionSecret), null);
  assert.equal(verifySession(token, exp - 1, "wrong"), null);
  const [payload, sig] = token.split(".");
  assert.equal(verifySession(`${payload}.${sig}x`, exp - 1, auth.sessionSecret), null);
  assert.equal(
    verifySession(token, exp - 1, auth.sessionSecret) === "admin",
    false,
  );
});

await check("anonymous paths are only health, static, and the login endpoints", () => {
  assert.equal(allowsAnonymous("GET", "/health"), true);
  assert.equal(allowsAnonymous("GET", "/"), true);
  assert.equal(allowsAnonymous("GET", "/assets/index.js"), true);
  assert.equal(allowsAnonymous("GET", "/api/session"), true);
  assert.equal(allowsAnonymous("POST", "/api/login"), true);
  assert.equal(allowsAnonymous("POST", "/api/logout"), true);
  assert.equal(allowsAnonymous("GET", "/api/projects"), false);
  assert.equal(allowsAnonymous("GET", "/ws"), false);
  assert.equal(allowsAnonymous("POST", "/api/login-extra"), false);
});

await check("login posts are not UI-version writes", () => {
  assert.equal(isGuardedWrite("POST", "/api/login"), false);
  assert.equal(isGuardedWrite("POST", "/api/logout"), false);
  assert.equal(isGuardedWrite("POST", "/api/projects"), true);
});

await check("loopback addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("203.0.113.8"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

await check("eight failures lock the address", () => {
  const limiter = new LoginAttemptLimiter(3, 10_000, 5_000);
  limiter.recordFailure("203.0.113.8", 1_000);
  limiter.recordFailure("203.0.113.8", 1_100);
  assert.equal(limiter.retryAfterMs("203.0.113.8", 1_200), 0);
  limiter.recordFailure("203.0.113.8", 1_200);
  assert.equal(limiter.retryAfterMs("203.0.113.8", 1_200), 5_000);
  limiter.recordSuccess("203.0.113.8");
  assert.equal(limiter.retryAfterMs("203.0.113.8", 1_200), 0);
});

await check("public /api requires the cookie; loopback and /health do not", async () => {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", createLoginGuard(auth));
  registerLoginRoutes(app, auth, new LoginAttemptLimiter(2, 60_000, 30_000));
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/projects", async () => [{ name: "secret" }]);

  const pub = { remoteAddress: "203.0.113.8" };
  const blocked = await app.inject({ method: "GET", url: "/api/projects", ...pub });
  assert.equal(blocked.statusCode, 401);

  const health = await app.inject({ method: "GET", url: "/health", ...pub });
  assert.equal(health.statusCode, 200);

  const local = await app.inject({
    method: "GET",
    url: "/api/projects",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(local.statusCode, 200);

  const session = await app.inject({ method: "GET", url: "/api/session", ...pub });
  assert.deepEqual(JSON.parse(session.body), {
    required: true,
    authenticated: false,
  });

  const bad = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "ada", password: "nope" },
    ...pub,
  });
  assert.equal(bad.statusCode, 401);
  assert.equal(JSON.parse(bad.body).error, "用户名或密码不正确");

  const again = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "ada", password: "still-nope" },
    ...pub,
  });
  assert.equal(again.statusCode, 401);
  const locked = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "ada", password: "s3cret-pass" },
    ...pub,
  });
  assert.equal(locked.statusCode, 429);

  const otherIp = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "ada", password: "s3cret-pass" },
    remoteAddress: "203.0.113.9",
  });
  assert.equal(otherIp.statusCode, 200);
  assert.equal(JSON.parse(otherIp.body).username, "ada");
  const setCookie = otherIp.headers["set-cookie"];
  const cookieLine = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.match(cookieLine, new RegExp(`^${LOGIN_COOKIE}=`));
  assert.match(cookieLine, /HttpOnly/i);
  const pair = cookieLine.split(";")[0];

  const authed = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: { cookie: pair },
    remoteAddress: "203.0.113.9",
  });
  assert.equal(authed.statusCode, 200);
  assert.equal(JSON.parse(authed.body)[0].name, "secret");

  const who = await app.inject({
    method: "GET",
    url: "/api/session",
    headers: { cookie: pair },
    remoteAddress: "203.0.113.9",
  });
  assert.equal(JSON.parse(who.body).authenticated, true);
  assert.equal(JSON.parse(who.body).required, true);

  assert.equal(
    requestIsAuthenticated(auth, {
      method: "GET",
      url: "/ws",
      headers: {},
      socket: { remoteAddress: "203.0.113.9" },
    }),
    false,
  );
  assert.equal(
    requestIsAuthenticated(auth, {
      method: "GET",
      url: "/ws",
      headers: { cookie: pair },
      socket: { remoteAddress: "203.0.113.9" },
    }),
    true,
  );

  await app.close();
});

await check("gate off leaves /api/session open and rejects login", async () => {
  const app = Fastify({ logger: false });
  const off = resolveLoginAuth({});
  app.addHook("onRequest", createLoginGuard(off));
  registerLoginRoutes(app, off);
  app.get("/api/projects", async () => []);
  const res = await app.inject({
    method: "GET",
    url: "/api/projects",
    remoteAddress: "203.0.113.8",
  });
  assert.equal(res.statusCode, 200);
  const session = await app.inject({
    method: "GET",
    url: "/api/session",
    remoteAddress: "203.0.113.8",
  });
  assert.deepEqual(JSON.parse(session.body), {
    required: false,
    authenticated: true,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "admin", password: "x" },
    remoteAddress: "203.0.113.8",
  });
  assert.equal(login.statusCode, 400);
  await app.close();
});

console.log("\nPASS: login auth");
