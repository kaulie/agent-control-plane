import type {
  AppSettings,
  DeploymentConfig,
  DeploymentServiceConfig,
} from "./types.js";
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

/** Validate / normalize one deployment service row. */
export function normalizeDeploymentService(
  patch: DeploymentServiceConfig,
): DeploymentServiceConfig {
  const serviceId = patch.serviceId?.trim() || "";
  if (!serviceId) {
    throw new Error("serviceId 不能为空");
  }

  const gracefulRestart = patch.gracefulRestart === true;
  if (!gracefulRestart) {
    return { serviceId, gracefulRestart: false };
  }

  const notify = patch.restartNotifyUrl?.trim() || "";
  const poll = patch.restartPollUrl?.trim() || "";
  if (!notify) {
    throw new Error(
      `service「${serviceId}」支持 graceful restart 时必须填写「重启前通知 URL」`,
    );
  }
  if (!poll) {
    throw new Error(
      `service「${serviceId}」支持 graceful restart 时必须填写「可重启轮询 URL」`,
    );
  }
  if (!isHttpUrl(notify)) {
    throw new Error(
      `service「${serviceId}」重启前通知 URL 必须是 http(s) 地址`,
    );
  }
  if (!isHttpUrl(poll)) {
    throw new Error(
      `service「${serviceId}」可重启轮询 URL 必须是 http(s) 地址`,
    );
  }

  return {
    serviceId,
    gracefulRestart: true,
    restartNotifyUrl: notify,
    restartPollUrl: poll,
  };
}

/**
 * Lift legacy flat deployment fields into a one-element services list.
 * `fallbackServiceId` is used when migrating (typically project.name).
 */
export function migrateLegacyDeployment(
  raw: DeploymentConfig | undefined,
  fallbackServiceId: string,
): DeploymentConfig | undefined {
  if (!raw) return undefined;

  if (Array.isArray(raw.services) && raw.services.length > 0) {
    const seen = new Set<string>();
    const services: DeploymentServiceConfig[] = [];
    for (const row of raw.services) {
      const normalized = normalizeDeploymentService(row);
      const id = normalized.serviceId.toLowerCase();
      if (seen.has(id)) {
        throw new Error(`重复的 serviceId：${normalized.serviceId}`);
      }
      seen.add(id);
      services.push(normalized);
    }
    return { services };
  }

  const hasLegacy =
    raw.gracefulRestart !== undefined ||
    Boolean(raw.restartNotifyUrl?.trim()) ||
    Boolean(raw.restartPollUrl?.trim());
  if (!hasLegacy) {
    if (Array.isArray(raw.services) && raw.services.length === 0) {
      return { services: [] };
    }
    return undefined;
  }

  const serviceId = fallbackServiceId.trim() || "default";
  return {
    services: [
      normalizeDeploymentService({
        serviceId,
        gracefulRestart: raw.gracefulRestart === true,
        restartNotifyUrl: raw.restartNotifyUrl,
        restartPollUrl: raw.restartPollUrl,
      }),
    ],
  };
}

/**
 * Normalize / validate project deployment settings (multi-service).
 * Patch replaces the full `services` list when `services` is provided.
 * Throws Error with a user-facing message on invalid input.
 */
export function normalizeDeploymentConfig(
  patch: DeploymentConfig | undefined,
  existing?: DeploymentConfig,
  fallbackServiceId = "default",
): DeploymentConfig | undefined {
  if (patch === undefined) return existing;

  // Full list replace when services key is present (including empty array).
  if (patch.services !== undefined) {
    return migrateLegacyDeployment(
      { services: patch.services },
      fallbackServiceId,
    ) ?? { services: [] };
  }

  // Legacy single-object patch: merge into existing first service or create one.
  const base =
    migrateLegacyDeployment(existing, fallbackServiceId)?.services ?? [];
  const targetId =
    base[0]?.serviceId?.trim() || fallbackServiceId.trim() || "default";
  const merged: DeploymentServiceConfig = {
    serviceId: targetId,
    gracefulRestart:
      patch.gracefulRestart !== undefined
        ? patch.gracefulRestart === true
        : base[0]?.gracefulRestart === true,
    restartNotifyUrl:
      patch.restartNotifyUrl !== undefined
        ? patch.restartNotifyUrl
        : base[0]?.restartNotifyUrl,
    restartPollUrl:
      patch.restartPollUrl !== undefined
        ? patch.restartPollUrl
        : base[0]?.restartPollUrl,
  };
  const rest = base.filter(
    (s) => s.serviceId.toLowerCase() !== targetId.toLowerCase(),
  );
  return {
    services: [normalizeDeploymentService(merged), ...rest],
  };
}

/** Upsert one service into a deployment config (by serviceId). */
export function upsertDeploymentService(
  existing: DeploymentConfig | undefined,
  service: DeploymentServiceConfig,
  fallbackServiceId = "default",
): DeploymentConfig {
  const normalized = normalizeDeploymentService(service);
  const current =
    migrateLegacyDeployment(existing, fallbackServiceId)?.services ?? [];
  const id = normalized.serviceId.toLowerCase();
  const next = current.filter((s) => s.serviceId.toLowerCase() !== id);
  next.push(normalized);
  next.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  return { services: next };
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
  opts?: { deploymentFallbackServiceId?: string },
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
      opts?.deploymentFallbackServiceId ?? "default",
    );
    if (deployment && (deployment.services?.length ?? 0) > 0) {
      next.deployment = deployment;
    } else if (deployment && deployment.services?.length === 0) {
      next.deployment = { services: [] };
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
