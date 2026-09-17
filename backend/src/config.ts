import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  envFlag,
  resolveGitViaProxyServerPath,
  resolveProxyUrl,
} from "./git-via-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Canonical Web Cursor source tree (deploy / product edits origin). */
export const CANONICAL_DEV_REPO = "/Users/gaolei/Projects/deepseek_web_cursor";

/** Per-project agent sandboxes live under this root. */
export const DEFAULT_AGENT_WORKSPACE_ROOT = "/Users/gaolei/agent-workspace";

/** Fallback listen port when no usable env var is set (runtime contract: 4211). */
export const DEFAULT_PORT = 4211;

/**
 * Startup port, resolved from the environment:
 *
 *   SERVICE_PORT  →  PORT (legacy)  →  DEFAULT_PORT
 *
 * Anything empty or not a valid TCP port is ignored (with a warning) instead of
 * turning into NaN / 0, so a typo never takes the gateway down on boot.
 */
export function resolvePort(
  env: Record<string, string | undefined> = process.env,
): number {
  const candidates: Array<[string, string | undefined]> = [
    ["SERVICE_PORT", env.SERVICE_PORT],
    ["PORT", env.PORT],
  ];
  for (const [name, raw] of candidates) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
    console.warn(
      `[config] ignoring invalid ${name}="${trimmed}" (expected 1-65535); falling back`,
    );
  }
  return DEFAULT_PORT;
}

/**
 * Project-level local workspace:
 * `<agentWorkspaceRoot>/<project-name>/`.
 * New tasks use `<projectRoot>/<taskId>/`.
 */
export function projectAgentWorkspaceRoot(
  projectName: string,
  root: string = DEFAULT_AGENT_WORKSPACE_ROOT,
): string {
  const safe =
    projectName
      .trim()
      .replace(/[/\\:\0]+/g, "-")
      .replace(/\s+/g, "-") || "project";
  return path.join(root, safe);
}

export interface Config {
  /** Git short SHA baked into web build; exposed via /health and X-App-Version. */
  appVersion: string;
  /** Listen port: SERVICE_PORT → PORT → 4211 (see resolvePort). */
  port: number;
  host: string;
  apiKey: string | undefined;
  /** Root directory; new tasks use `<root>/<project-name>/<taskId>/`. */
  agentWorkspaceRoot: string;
  /** @deprecated alias of agentWorkspaceRoot (logging / gateway ctor). */
  agentWorkspace: string;
  /** Product source used for deploy and special system tasks. */
  canonicalDevRepo: string;
  /** Product package root (contains mcp-servers/, backend/, web/). */
  productRoot: string;
  model: string | undefined;
  /** Which agent runtime adapter to use: "cursor" | "cline". */
  provider: string;
  clineProviderId: string;
  clineModel: string | undefined;
  clineApiKey: string | undefined;
  clineBaseUrl: string | undefined;
  clineSystemPrompt: string | undefined;
  dataDir: string;
  webDistDir: string;
  /**
   * Local HTTP proxy for outbound git/gh (e.g. http://127.0.0.1:7897).
   * Empty string disables all git-via-proxy features.
   */
  gitViaProxyUrl: string;
  /** When true and URL set: inject HTTP(S)_PROXY into gateway process (Shell/gh). */
  gitViaProxyShell: boolean;
  /** When true and URL set: inject git-via-proxy MCP into Cursor agents. */
  gitViaProxyMcp: boolean;
  /** Absolute path to mcp-servers/git-via-proxy/server.mjs */
  gitViaProxyServerPath: string;
  /** Global cap on concurrent agent runs across all tasks/providers. */
  maxConcurrentRuns: number;
  /**
   * Gateway RSS limit in MiB. When exceeded and a run is active, the oldest
   * active run is cancelled to shed memory pressure. 0 disables auto-shed.
   */
  agentRssLimitMb: number;
  /**
   * When true (default), a platform restart-notify pauses starting new/queued
   * runs until the in-flight agents finish (graceful restart). When false, the
   * gateway keeps accepting runs while the platform restarts it.
   * Env: GRACEFUL_RESTART=1|0
   */
  gracefulRestart: boolean;
  /**
   * Safety timeout for that admission pause before the queue resumes on its own,
   * in case the platform restart never arrives (default 5 min).
   * Env: DEPLOY_GRACEFUL_WAIT_MS or DEPLOY_GRACEFUL_WAIT_SEC
   */
  deployGracefulWaitMs: number;
}

/** Deployed VERSION file next to web/backend (authoritative after rsync). */
export function readRuntimeVersion(productRoot: string): string | null {
  try {
    const p = path.join(productRoot, "VERSION");
    if (!fs.existsSync(p)) return null;
    const v = fs.readFileSync(p, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function resolveFromBackend(...segments: string[]): string {
  return path.resolve(__dirname, "..", ...segments);
}

function resolveWorkspaceRoot(raw: string | undefined): string {
  const trimmed = raw?.trim();
  // Legacy: single shared cwd pointed at the dev repo or relative sandbox.
  // New default is a dedicated multi-task root.
  if (
    !trimmed ||
    trimmed === "../workspace" ||
    trimmed === "workspace" ||
    trimmed === CANONICAL_DEV_REPO
  ) {
    return DEFAULT_AGENT_WORKSPACE_ROOT;
  }
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(__dirname, "..", trimmed);
}

export function loadConfig(): Config {
  // Load .env if present (must run before reading process.env below).
  const envPath = resolveFromBackend(".env");
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch (err) {
      console.warn(`[config] failed to load ${envPath}:`, err);
    }
  }

  const agentWorkspaceRoot = resolveWorkspaceRoot(
    process.env.AGENT_WORKSPACE_ROOT?.trim() ||
      process.env.AGENT_WORKSPACE?.trim(),
  );

  // resolveFromBackend already goes up one level from src|dist → backend/.
  // One more ".." reaches the product root (contains mcp-servers/, web/, backend/).
  const productRoot = resolveFromBackend("..");
  const gitViaProxyUrl = resolveProxyUrl(process.env.GIT_VIA_PROXY_URL);
  const gitViaProxyShell = envFlag(process.env.GIT_VIA_PROXY_SHELL, true);
  const gitViaProxyMcp = envFlag(process.env.GIT_VIA_PROXY_MCP, true);
  const gitViaProxyServerPath = resolveGitViaProxyServerPath(productRoot);

  const waitMsRaw = process.env.DEPLOY_GRACEFUL_WAIT_MS?.trim();
  const waitSecRaw = process.env.DEPLOY_GRACEFUL_WAIT_SEC?.trim();
  let deployGracefulWaitMs = 5 * 60 * 1000;
  if (waitMsRaw) {
    deployGracefulWaitMs = Math.max(0, Number(waitMsRaw) || 0);
  } else if (waitSecRaw) {
    deployGracefulWaitMs = Math.max(0, (Number(waitSecRaw) || 0) * 1000);
  }

  return {
    appVersion: process.env.APP_VERSION?.trim() || "dev",
    port: resolvePort(process.env),
    host: process.env.HOST || "127.0.0.1",
    apiKey: process.env.CURSOR_API_KEY || undefined,
    agentWorkspaceRoot,
    agentWorkspace: agentWorkspaceRoot,
    canonicalDevRepo: CANONICAL_DEV_REPO,
    productRoot,
    model: process.env.CURSOR_MODEL || undefined,
    provider: process.env.AGENT_PROVIDER?.trim() || "cursor",
    clineProviderId: process.env.CLINE_PROVIDER_ID?.trim() || "deepseek",
    clineModel: process.env.CLINE_MODEL?.trim() || undefined,
    clineApiKey: process.env.DEEPSEEK_API_KEY?.trim() || undefined,
    clineBaseUrl: process.env.CLINE_BASE_URL?.trim() || undefined,
    clineSystemPrompt: process.env.CLINE_SYSTEM_PROMPT?.trim() || undefined,
    dataDir: resolveFromBackend("data"),
    webDistDir: resolveFromBackend("..", "web", "dist"),
    gitViaProxyUrl,
    gitViaProxyShell,
    gitViaProxyMcp,
    gitViaProxyServerPath,
    maxConcurrentRuns: Math.max(
      1,
      Number(process.env.AGENT_MAX_CONCURRENT_RUNS || 2),
    ),
    agentRssLimitMb: Math.max(
      0,
      Number(process.env.AGENT_RSS_LIMIT_MB || 2048),
    ),
    gracefulRestart: envFlag(
      process.env.GRACEFUL_RESTART ?? process.env.graceful_restart,
      true,
    ),
    deployGracefulWaitMs,
  };
}
