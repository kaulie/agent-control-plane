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
 * Organization service (department / person catalogue). Local runtime contract:
 * port 4244, `GET /api/v1/departments`.
 */
export const DEFAULT_ORGANIZATION_API_URL = "http://127.0.0.1:4244";

/** How long we wait for the organization service before degrading to "不可用". */
export const DEFAULT_ORGANIZATION_TIMEOUT_MS = 3000;

/**
 * Base URL of the organization service (`ORGANIZATION_API_URL`), trailing
 * slashes stripped so `base + "/api/v1/departments"` never doubles up.
 */
export function resolveOrganizationApiUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.ORGANIZATION_API_URL?.trim();
  return (raw || DEFAULT_ORGANIZATION_API_URL).replace(/\/+$/, "");
}

/** Timeout for organization-service calls; invalid values fall back to default. */
export function resolveOrganizationTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.ORGANIZATION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ORGANIZATION_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  console.warn(
    `[config] ignoring invalid ORGANIZATION_TIMEOUT_MS="${raw}"; using ${DEFAULT_ORGANIZATION_TIMEOUT_MS}`,
  );
  return DEFAULT_ORGANIZATION_TIMEOUT_MS;
}

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
 *
 * ⚠️ 它**不再**是新 task 的工作区（老版本是 `<projectRoot>/<taskId>/`）；
 * 现在只用来读「项目级规则」（`GET /api/projects/:id/settings` → cwdRules）。
 * 新 task 的工作区见 {@link agentWorkspaceDir}。
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

/**
 * Agent 工作区目录名：`agent-<agentid>`（统一 `agent-` 前缀，provider 自己的
 * 前缀 `cls-` 去掉）。
 *
 * 目录名**就是**这个 agent 的 id → 「目录属于哪个 agent」不用查库：
 * - `agent-7362ceb1-…`（Cursor）→ `agent-7362ceb1-…`
 * - `cls-5f7393dd40a44b06`（Cline）→ `agent-5f7393dd40a44b06`
 */
export function agentWorkspaceDirName(agentId: string): string {
  const bare = agentId
    .trim()
    .replace(/^(agent|cls)-/i, "")
    .replace(/[/\\:\0\s]+/g, "-");
  return `agent-${bare || "unknown"}`;
}

/**
 * 每个 agent 自己的工作区：`<agentWorkspaceRoot>/agent-<agentid>`。
 *
 * 新建任务时 agent id 由网关**预分配**（`agent-…`），所以目录一创建就带上了
 * 这个 agent 的 id（不再有 `<project>/<taskId>` 那层）。
 */
export function agentWorkspaceDir(
  agentId: string,
  root: string = DEFAULT_AGENT_WORKSPACE_ROOT,
): string {
  return path.join(root, agentWorkspaceDirName(agentId));
}

export interface Config {
  /** Git short SHA baked into web build; exposed via /health and X-App-Version. */
  appVersion: string;
  /** Listen port: SERVICE_PORT → PORT → 4211 (see resolvePort). */
  port: number;
  host: string;
  apiKey: string | undefined;
  /** Root directory; new tasks use `<root>/agent-<agentid>/`. */
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
  /** 启用 SDK 自带上下文压缩（CLINE_COMPACTION=0 关闭；见 context/README.md 探针）。 */
  clineCompaction: boolean;
  /** 上下文自动轮转兜底（CONTEXT_AUTO_ROTATE=0 关闭）。 */
  contextAutoRotate: boolean;
  /** 压缩策略：basic（默认）/ agentic（LLM 摘要式，需 summarizer）。 */
  clineCompactionStrategy: "basic" | "agentic";
  /** agentic 压缩用的模型（缺省 = 会话模型）。 */
  clineCompactionModel: string | undefined;
  /** **模型生成 digest**：默认关（CONTEXT_DIGEST=1 开）。 */
  contextDigest: boolean;
  /** digest 用的模型（缺省 = 会话模型）。 */
  contextDigestModel: string | undefined;
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
  /** Absolute path to mcp-servers/git-via-proxy/server.mjs. */
  gitViaProxyServerPath: string;
  /** Base URL of the organization service (department catalogue). */
  organizationApiUrl: string;
  /** Timeout for organization-service calls (ms). */
  organizationTimeoutMs: number;
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
    clineCompaction: process.env.CLINE_COMPACTION?.trim() !== "0",
    contextAutoRotate: process.env.CONTEXT_AUTO_ROTATE?.trim() !== "0",
    clineCompactionStrategy: process.env.CLINE_COMPACTION?.trim() === "agentic" ? "agentic" : "basic",
    clineCompactionModel: process.env.CLINE_COMPACTION_MODEL?.trim() || undefined,
    contextDigest:
      process.env.CONTEXT_DIGEST?.trim() === "1" || process.env.CONTEXT_DIGEST?.trim() === "true",
    contextDigestModel: process.env.CONTEXT_DIGEST_MODEL?.trim() || undefined,
    dataDir: resolveFromBackend("data"),
    webDistDir: resolveFromBackend("..", "web", "dist"),
    gitViaProxyUrl,
    gitViaProxyShell,
    gitViaProxyMcp,
    gitViaProxyServerPath,
    organizationApiUrl: resolveOrganizationApiUrl(process.env),
    organizationTimeoutMs: resolveOrganizationTimeoutMs(process.env),
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
