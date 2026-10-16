/**
 * Fixed-account login for the control plane.
 *
 * Set `LOGIN_PASSWORD` to require a username + that password from non-loopback
 * clients (the public URL). Leave it empty and the gate stays off, which is
 * the local-dev default. `LOGIN_USERNAME` defaults to `admin`.
 *
 * Loopback callers (deployment platform, on-box autonomy) skip the gate so
 * those contracts keep working after the password is turned on.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LOGIN_COOKIE = "wc_session";
export const DEFAULT_LOGIN_USERNAME = "admin";
/** How long a successful login stays valid. */
export const LOGIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LoginAuth {
  enabled: boolean;
  /** Expected username. Empty when the gate is off. */
  username: string;
  /** Expected password. Empty when the gate is off. Never log this. */
  password: string;
  /** HMAC key for the session cookie. Falls back to the password. */
  sessionSecret: string;
}

const DISABLED: LoginAuth = {
  enabled: false,
  username: "",
  password: "",
  sessionSecret: "",
};

export function resolveLoginAuth(
  env: Record<string, string | undefined> = process.env,
): LoginAuth {
  const password = env.LOGIN_PASSWORD?.trim() ?? "";
  if (!password) return DISABLED;
  const username = env.LOGIN_USERNAME?.trim() || DEFAULT_LOGIN_USERNAME;
  const sessionSecret = env.LOGIN_SESSION_SECRET?.trim() || password;
  return { enabled: true, username, password, sessionSecret };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time check of the configured username and password. */
export function fixedCredentialsMatch(
  auth: LoginAuth,
  username: string,
  password: string,
): boolean {
  const userOk = timingSafeEqual(sha256(auth.username), sha256(username));
  const passOk = timingSafeEqual(sha256(auth.password), sha256(password));
  return userOk && passOk;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signSession(
  username: string,
  expiresAtMs: number,
  secret: string,
): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: username, exp: expiresAtMs }), "utf8"),
  );
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Username from a valid unexpired cookie token, otherwise null. */
export function verifySession(
  token: string,
  nowMs: number,
  secret: string,
): string | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(payload).digest());
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: unknown;
      exp?: unknown;
    };
    if (typeof body.u !== "string" || !body.u) return null;
    if (typeof body.exp !== "number" || !Number.isFinite(body.exp)) return null;
    if (body.exp <= nowMs) return null;
    return body.u;
  } catch {
    return null;
  }
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  const value = encodeURIComponent(token);
  return `${LOGIN_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.replace(/^::ffff:/i, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1";
}

function requestPath(url: string): string {
  return (url.split("?")[0] ?? url) || "/";
}

/**
 * Paths a browser can hit before it has a session: the SPA shell, health,
 * and the login endpoints themselves. Everything under `/api` and `/ws`
 * stays closed.
 */
export function allowsAnonymous(method: string, url: string): boolean {
  const path = requestPath(url);
  const m = method.toUpperCase();
  if (m === "OPTIONS" || m === "HEAD") {
    if (path.startsWith("/api/") || path === "/ws") {
      return path === "/api/session";
    }
    return true;
  }
  if (path === "/health") return true;
  if (path === "/api/session" && m === "GET") return true;
  if (path === "/api/login" && m === "POST") return true;
  if (path === "/api/logout" && m === "POST") return true;
  if (path === "/ws" || path.startsWith("/api/") || path === "/api") return false;
  return true;
}

export interface LoginRequestView {
  method: string;
  url: string;
  headers: { cookie?: string | string[] };
  socket: { remoteAddress?: string };
}

function cookieHeader(headers: LoginRequestView["headers"]): string | undefined {
  const raw = headers.cookie;
  if (Array.isArray(raw)) return raw.join("; ");
  return raw;
}

/** True when this request may proceed (gate off, loopback, public, or a valid session). */
export function requestIsAuthenticated(
  auth: LoginAuth,
  req: LoginRequestView,
  nowMs: number = Date.now(),
): boolean {
  if (!auth.enabled) return true;
  if (isLoopbackAddress(req.socket.remoteAddress)) return true;
  if (allowsAnonymous(req.method, req.url)) return true;
  const token = readCookie(cookieHeader(req.headers), LOGIN_COOKIE);
  if (!token) return false;
  return verifySession(token, nowMs, auth.sessionSecret) === auth.username;
}

export function sessionUsername(
  auth: LoginAuth,
  req: LoginRequestView,
  nowMs: number = Date.now(),
): string | null {
  if (!auth.enabled) return null;
  const token = readCookie(cookieHeader(req.headers), LOGIN_COOKIE);
  if (!token) return null;
  const user = verifySession(token, nowMs, auth.sessionSecret);
  return user === auth.username ? user : null;
}

/**
 * Slows online guessing of the fixed password. A handful of failures from
 * one address locks that address briefly; a correct login clears it.
 */
export class LoginAttemptLimiter {
  private failures = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();

  constructor(
    private readonly maxFailures = 8,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly lockMs = 60 * 1000,
  ) {}

  retryAfterMs(ip: string, nowMs: number): number {
    const until = this.lockedUntil.get(ip) ?? 0;
    if (until <= nowMs) {
      if (until) this.lockedUntil.delete(ip);
      return 0;
    }
    return until - nowMs;
  }

  recordFailure(ip: string, nowMs: number): void {
    const recent = (this.failures.get(ip) ?? []).filter((t) => nowMs - t < this.windowMs);
    recent.push(nowMs);
    this.failures.set(ip, recent);
    if (recent.length >= this.maxFailures) {
      this.lockedUntil.set(ip, nowMs + this.lockMs);
      this.failures.delete(ip);
    }
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
    this.lockedUntil.delete(ip);
  }
}
