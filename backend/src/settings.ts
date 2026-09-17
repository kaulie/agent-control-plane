import type { AppSettings, DepartmentConfig } from "./types.js";
import { DEFAULT_AGENT_WORKSPACE_ROOT } from "./config.js";

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
  if (patch.department !== undefined) {
    // Selecting "（未设置）" sends both empty → drop the field entirely.
    const department = normalizeDepartment(patch.department);
    if (department) {
      next.department = department;
    } else {
      delete next.department;
    }
  }
  return next;
}

/** Trimmed department config, or undefined when nothing was picked. */
export function normalizeDepartment(
  config: DepartmentConfig | undefined,
): DepartmentConfig | undefined {
  const departmentId = config?.departmentId?.trim() || "";
  const departmentName = config?.departmentName?.trim() || "";
  if (!departmentId && !departmentName) return undefined;
  return {
    ...(departmentId ? { departmentId } : {}),
    ...(departmentName ? { departmentName } : {}),
  };
}

/**
 * The project's own department wins outright; a global setting only acts as a
 * default (an id from one side never gets paired with a name from the other).
 */
export function resolveDepartment(
  global: AppSettings,
  project: AppSettings,
): DepartmentConfig | undefined {
  return normalizeDepartment(project.department) ?? normalizeDepartment(global.department);
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
  const runtime = resolveRuntimeDefaults(global, project);
  if (runtime.defaultProvider || runtime.defaultModel) {
    out.runtime = runtime;
  }
  if (global.workspace?.root?.trim()) {
    out.workspace = { root: resolveWorkspaceRoot(global) };
  }
  const department = resolveDepartment(global, project);
  if (department) {
    out.department = department;
  }
  return out;
}
