import type { AppSettings, DeploymentConfig } from "./types.js";
import { DEFAULT_AGENT_WORKSPACE_ROOT } from "./config.js";

const GLOBAL_RULES_HEADING = "# Global agent rules";
const PROJECT_RULES_HEADING = "# Project agent rules";
const SECTION_SEP = "\n\n---\n\n";

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalize / validate project deployment settings.
 * Throws Error with a user-facing message on invalid input.
 */
export function normalizeDeploymentConfig(
  patch: DeploymentConfig | undefined,
  existing?: DeploymentConfig,
): DeploymentConfig | undefined {
  if (patch === undefined) return existing;

  const gracefulRestart = patch.gracefulRestart === true;
  if (!gracefulRestart) {
    return { gracefulRestart: false };
  }

  const notify =
    (patch.restartNotifyUrl !== undefined
      ? patch.restartNotifyUrl
      : existing?.restartNotifyUrl
    )?.trim() || "";
  const poll =
    (patch.restartPollUrl !== undefined
      ? patch.restartPollUrl
      : existing?.restartPollUrl
    )?.trim() || "";

  if (!notify) {
    throw new Error("支持 graceful restart 时必须填写「重启前通知 URL」");
  }
  if (!poll) {
    throw new Error("支持 graceful restart 时必须填写「可重启轮询 URL」");
  }
  if (!isHttpUrl(notify)) {
    throw new Error("重启前通知 URL 必须是 http(s) 地址");
  }
  if (!isHttpUrl(poll)) {
    throw new Error("可重启轮询 URL 必须是 http(s) 地址");
  }

  return {
    gracefulRestart: true,
    restartNotifyUrl: notify,
    restartPollUrl: poll,
  };
}

export function parseSettings(raw: string | null | undefined): AppSettings {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as AppSettings;
  } catch {
    return {};
  }
}

export function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(settings);
}

/** Shallow-merge patch into existing settings. */
export function patchSettings(
  existing: AppSettings,
  patch: AppSettings,
): AppSettings {
  const next: AppSettings = { ...existing };
  if (patch.agent !== undefined) {
    next.agent = { ...existing.agent, ...patch.agent };
  }
  if (patch.plan !== undefined) {
    next.plan = { ...existing.plan, ...patch.plan };
  }
  if (patch.runtime !== undefined) {
    const runtime = { ...existing.runtime, ...patch.runtime };
    if (!runtime.defaultProvider?.trim()) {
      delete runtime.defaultProvider;
    } else {
      runtime.defaultProvider = runtime.defaultProvider.trim();
    }
    if (!runtime.defaultModel?.trim()) {
      delete runtime.defaultModel;
    } else {
      runtime.defaultModel = runtime.defaultModel.trim();
    }
    if (runtime.defaultProvider || runtime.defaultModel) {
      next.runtime = runtime;
    } else {
      delete next.runtime;
    }
  }
  if (patch.workspace !== undefined) {
    const root = patch.workspace.root?.trim() || "";
    if (root) {
      next.workspace = { root };
    } else {
      delete next.workspace;
    }
  }
  if (patch.deployment !== undefined) {
    const deployment = normalizeDeploymentConfig(
      patch.deployment,
      existing.deployment,
    );
    if (deployment) {
      next.deployment = deployment;
    } else {
      delete next.deployment;
    }
  }
  return next;
}

export function resolvePlanExportDir(
  global: AppSettings,
  project: AppSettings,
): string | undefined {
  const dir =
    project.plan?.exportDir?.trim() || global.plan?.exportDir?.trim() || "";
  return dir || undefined;
}

export function resolveEffectiveRules(
  global: AppSettings,
  project: AppSettings,
): string {
  const parts: string[] = [];
  const globalRules = global.agent?.rules?.trim();
  const projectRules = project.agent?.rules?.trim();
  if (globalRules) {
    parts.push(`${GLOBAL_RULES_HEADING}\n\n${globalRules}`);
  }
  if (projectRules) {
    parts.push(`${PROJECT_RULES_HEADING}\n\n${projectRules}`);
  }
  return parts.join(SECTION_SEP);
}

export function resolveRuntimeDefaults(
  global: AppSettings,
  project: AppSettings,
): { defaultProvider?: string; defaultModel?: string } {
  const defaultProvider =
    project.runtime?.defaultProvider?.trim() ||
    global.runtime?.defaultProvider?.trim() ||
    undefined;
  const defaultModel =
    project.runtime?.defaultModel?.trim() ||
    global.runtime?.defaultModel?.trim() ||
    undefined;
  return {
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  };
}

/** Global-only WorkspaceRoot; empty falls back to default/env. */
export function resolveWorkspaceRoot(
  global: AppSettings,
  fallback: string = DEFAULT_AGENT_WORKSPACE_ROOT,
): string {
  return global.workspace?.root?.trim() || fallback;
}

export function mergeSettings(
  global: AppSettings,
  project: AppSettings,
): AppSettings {
  const out: AppSettings = {};
  const rules = resolveEffectiveRules(global, project);
  if (rules) out.agent = { rules };
  const exportDir = resolvePlanExportDir(global, project);
  if (exportDir) out.plan = { exportDir };
  const runtime = resolveRuntimeDefaults(global, project);
  if (runtime.defaultProvider || runtime.defaultModel) {
    out.runtime = runtime;
  }
  if (global.workspace?.root?.trim()) {
    out.workspace = { root: resolveWorkspaceRoot(global) };
  }
  // Deployment is project-scoped only (not inherited from global).
  if (project.deployment) {
    out.deployment = { ...project.deployment };
  }
  return out;
}
