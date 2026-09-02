/**
 * Unit checks for settings merge logic.
 * Usage: node backend/scripts/test-settings.mjs
 */
import { mergeSettings, parseSettings, patchSettings, resolveEffectiveRules, resolvePlanExportDir } from "../dist/settings.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(JSON.stringify(parseSettings(null)), "{}", "null -> {}");
assert(JSON.stringify(parseSettings("not json")), "{}", "bad json -> {}");

const global = { agent: { rules: "global rule" } };
const project = { agent: { rules: "project rule" } };
const merged = resolveEffectiveRules(global, project);
assert(merged.includes("global rule"), "merged includes global");
assert(merged.includes("project rule"), "merged includes project");
assert(merged.indexOf("project rule") > merged.indexOf("global rule"), "project after global");

assert(resolveEffectiveRules({}, {}) === "", "empty merge");
assert(
  mergeSettings(global, {}).agent?.rules?.includes("global rule"),
  "effective from global only",
);

const patched = patchSettings({ agent: { rules: "a" } }, { agent: { rules: "b" } });
assert(patched.agent?.rules === "b", "patch replaces rules");

const planPatched = patchSettings(
  { plan: { exportDir: "/global" } },
  { plan: { exportDir: "/project" } },
);
assert(planPatched.plan?.exportDir === "/project", "patch replaces plan exportDir");

assert(resolvePlanExportDir({}, {}) === undefined, "no export dir when unset");
assert(
  resolvePlanExportDir({ plan: { exportDir: "/global" } }, {}) === "/global",
  "global export dir",
);
assert(
  resolvePlanExportDir(
    { plan: { exportDir: "/global" } },
    { plan: { exportDir: "/project" } },
  ) === "/project",
  "project overrides global export dir",
);

const runtimePatched = patchSettings(
  { runtime: { defaultProvider: "cursor", defaultModel: "a" } },
  { runtime: { defaultProvider: "", defaultModel: "b" } },
);
assert(runtimePatched.runtime?.defaultProvider === undefined, "empty provider clears");
assert(runtimePatched.runtime?.defaultModel === "b", "model patch kept");

const runtimeMerged = mergeSettings(
  { runtime: { defaultProvider: "cursor" } },
  { runtime: { defaultProvider: "cline", defaultModel: "deepseek-chat" } },
);
assert(runtimeMerged.runtime?.defaultProvider === "cline", "project provider wins");
assert(runtimeMerged.runtime?.defaultModel === "deepseek-chat", "project model wins");

console.log("PASS: settings merge logic");
