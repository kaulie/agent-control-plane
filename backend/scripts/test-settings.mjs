/**
 * Unit checks for settings merge logic.
 * Usage: node backend/scripts/test-settings.mjs
 */
import { mergeSettings, parseSettings, patchSettings } from "../dist/settings.js";
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(JSON.stringify(parseSettings(null)), "{}", "null -> {}");
assert(JSON.stringify(parseSettings("not json")), "{}", "bad json -> {}");

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

// ---- 所属部门 (department) --------------------------------------------------
const deptPatched = patchSettings({}, {
  department: { departmentId: " D0001 ", departmentName: " SRE部门 " },
});
assert(deptPatched.department?.departmentId === "D0001", "department id trimmed + kept");
assert(deptPatched.department?.departmentName === "SRE部门", "department name snapshot kept");

const deptCleared = patchSettings(
  { department: { departmentId: "D0001", departmentName: "SRE部门" } },
  { department: { departmentId: "", departmentName: "" } },
);
assert(deptCleared.department === undefined, "empty department clears the field");

const deptProjectWins = mergeSettings(
  { department: { departmentId: "D0001", departmentName: "SRE部门" } },
  { department: { departmentId: "D0002", departmentName: "工程效能部门" } },
);
assert(deptProjectWins.department?.departmentId === "D0002", "project department wins outright");
assert(
  deptProjectWins.department?.departmentName === "工程效能部门",
  "project name is kept (never mixed with the global one)",
);

const deptFromGlobal = mergeSettings(
  { department: { departmentId: "D0001", departmentName: "SRE部门" } },
  {},
);
assert(deptFromGlobal.department?.departmentId === "D0001", "global department becomes the effective one");
assert(mergeSettings({}, {}).department === undefined, "no department → omitted");

console.log("PASS: settings merge logic");
