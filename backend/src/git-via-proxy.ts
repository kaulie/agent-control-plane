import fs from "node:fs";
import path from "node:path";

const PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
] as const;

const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

/** Parse 0/1/true/false style flags; empty → defaultOn. */
export function envFlag(raw: string | undefined, defaultOn: boolean): boolean {
  const t = raw?.trim().toLowerCase();
  if (!t) return defaultOn;
  if (["0", "false", "off", "no"].includes(t)) return false;
  if (["1", "true", "on", "yes"].includes(t)) return true;
  return defaultOn;
}

/**
 * Resolve GIT_VIA_PROXY_URL.
 * - unset → defaultUrl (local default)
 * - set but blank → disabled ("")
 */
export function resolveProxyUrl(
  raw: string | undefined,
  defaultUrl = "http://127.0.0.1:7897",
): string {
  if (raw === undefined) return defaultUrl;
  return raw.trim();
}

export function resolveGitViaProxyServerPath(productRoot: string): string {
  return path.join(productRoot, "mcp-servers", "git-via-proxy", "server.mjs");
}

/** Inject HTTP(S)_PROXY into the current process (Shell / gh inherit). */
export function applyShellProxyEnv(proxyUrl: string): void {
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  if (!process.env.no_proxy?.trim()) process.env.no_proxy = DEFAULT_NO_PROXY;
  if (!process.env.NO_PROXY?.trim()) process.env.NO_PROXY = DEFAULT_NO_PROXY;
}

export function assertMcpServerPresent(serverPath: string): boolean {
  return fs.existsSync(serverPath);
}
