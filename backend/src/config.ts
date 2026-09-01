import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Canonical Web Cursor source tree (deploy / product edits origin). */
export const CANONICAL_DEV_REPO = "/Users/gaolei/Projects/deepseek_web_cursor";

/** Per-task agent sandboxes live under this root (one directory per task). */
export const DEFAULT_AGENT_WORKSPACE_ROOT = "/Users/gaolei/agent-workspace";

export interface Config {
  port: number;
  host: string;
  apiKey: string | undefined;
  /** Root directory; each new task gets `<root>/<taskId>/`. */
  agentWorkspaceRoot: string;
  /** @deprecated alias of agentWorkspaceRoot (logging / gateway ctor). */
  agentWorkspace: string;
  /** Product source used for deploy and special system tasks. */
  canonicalDevRepo: string;
  model: string | undefined;
  dataDir: string;
  webDistDir: string;
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

  return {
    port: Number(process.env.PORT || 4211),
    host: process.env.HOST || "127.0.0.1",
    apiKey: process.env.CURSOR_API_KEY || undefined,
    agentWorkspaceRoot,
    agentWorkspace: agentWorkspaceRoot,
    canonicalDevRepo: CANONICAL_DEV_REPO,
    model: process.env.CURSOR_MODEL || undefined,
    dataDir: resolveFromBackend("data"),
    webDistDir: resolveFromBackend("..", "web", "dist"),
  };
}
