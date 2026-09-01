import type { AppSettings } from "./types.js";

const GLOBAL_RULES_HEADING = "# Global agent rules";
const PROJECT_RULES_HEADING = "# Project agent rules";
const SECTION_SEP = "\n\n---\n\n";

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
  return next;
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

export function mergeSettings(
  global: AppSettings,
  project: AppSettings,
): AppSettings {
  const rules = resolveEffectiveRules(global, project);
  if (!rules) return {};
  return { agent: { rules } };
}
