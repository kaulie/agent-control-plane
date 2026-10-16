/**
 * HTTP surface for the fixed-account login gate.
 *
 * Register {@link createLoginGuard} on the root Fastify instance *before*
 * the websocket plugin so the upgrade to `/ws` is rejected too. Login routes
 * are mounted from `registerRoutes` so the OpenAPI contract sees them.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  LOGIN_SESSION_TTL_MS,
  LoginAttemptLimiter,
  fixedCredentialsMatch,
  isLoopbackAddress,
  type LoginAuth,
  type LoginRequestView,
  requestIsAuthenticated,
  sessionCookie,
  sessionUsername,
  signSession,
} from "../login-auth.js";

function viewOf(req: FastifyRequest): LoginRequestView {
  return {
    method: req.method,
    url: req.url,
    headers: { cookie: req.headers.cookie },
    socket: { remoteAddress: req.socket.remoteAddress },
  };
}

export function createLoginGuard(auth: LoginAuth) {
  return async function loginGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (requestIsAuthenticated(auth, viewOf(req))) return;
    await reply.code(401).send({ error: "需要登录" });
  };
}

export function registerLoginRoutes(
  app: FastifyInstance,
  auth: LoginAuth,
  limiter: LoginAttemptLimiter = new LoginAttemptLimiter(),
): void {
  app.get("/api/session", async (req) => {
    if (!auth.enabled) return { required: false, authenticated: true };
    const username = sessionUsername(auth, viewOf(req));
    if (username) return { required: true, authenticated: true, username };
    // Same-machine callers (and a browser on 127.0.0.1) are already inside.
    if (isLoopbackAddress(req.socket.remoteAddress)) {
      return { required: false, authenticated: true, username: auth.username };
    }
    return { required: true, authenticated: false };
  });

  app.post<{ Body: { username?: unknown; password?: unknown } | null }>(
    "/api/login",
    async (req, reply) => {
      if (!auth.enabled) {
        return reply.code(400).send({ error: "登录未启用" });
      }
      const ip = req.socket.remoteAddress ?? "unknown";
      const retryMs = limiter.retryAfterMs(ip, Date.now());
      if (retryMs > 0) {
        reply.header("retry-after", String(Math.ceil(retryMs / 1000)));
        return reply.code(429).send({ error: "尝试次数过多，请稍后再试" });
      }
      const body = req.body ?? {};
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username || !password) {
        return reply.code(400).send({ error: "请输入用户名和密码" });
      }
      if (!fixedCredentialsMatch(auth, username, password)) {
        limiter.recordFailure(ip, Date.now());
        return reply.code(401).send({ error: "用户名或密码不正确" });
      }
      limiter.recordSuccess(ip);
      const token = signSession(
        auth.username,
        Date.now() + LOGIN_SESSION_TTL_MS,
        auth.sessionSecret,
      );
      reply.header(
        "set-cookie",
        sessionCookie(token, Math.floor(LOGIN_SESSION_TTL_MS / 1000)),
      );
      return { ok: true, username: auth.username };
    },
  );

  app.post("/api/logout", async (_req, reply) => {
    reply.header("set-cookie", sessionCookie("", 0));
    return { ok: true };
  });
}
