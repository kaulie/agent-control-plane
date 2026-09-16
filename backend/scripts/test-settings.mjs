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

console.log("PASS: settings merge logic");
