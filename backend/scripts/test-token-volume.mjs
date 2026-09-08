/**
 * Unit checks for token volume口径 (Cursor inclusive vs disjoint).
 * Usage: npm run build --workspace backend && node backend/scripts/test-token-volume.mjs
 */

let tokens;
try {
  tokens = await import("../dist/usage/tokens.js");
} catch {
  console.error("Build backend first: npm run build --workspace backend");
  process.exit(1);
}

const {
  tokenVolume,
  normalizeTokenUsage,
  dashboardTokenParts,
  billableInputTokens,
  volumeModeForProvider,
} = tokens;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

assert(volumeModeForProvider("cursor") === "inclusive", "cursor should be inclusive");
assert(volumeModeForProvider("cline") === "inclusive", "cline should be inclusive");

const sample = {
  inputTokens: 185869,
  outputTokens: 475,
  cacheReadTokens: 185728,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

assert(
  tokenVolume(sample, "cursor") === 185869 + 475,
  "cursor volume must not add cacheRead again",
);
assert(
  tokenVolume(sample, "cline") === 185869 + 475,
  "cline volume is input+output",
);

const parts = dashboardTokenParts(sample);
assert(parts.inputWithoutCache === 141, `Input(w/o)=${parts.inputWithoutCache}`);
assert(parts.cacheTokens === 185728, `Cache=${parts.cacheTokens}`);
assert(parts.outputTokens === 475, `Out=${parts.outputTokens}`);
assert(
  parts.totalTokens === 185869 + 475,
  `mapped total=${parts.totalTokens}`,
);
assert(
  parts.inputWithoutCache + parts.cacheTokens + parts.outputTokens ===
    parts.totalTokens,
  "dashboard 3-col sum",
);

const normalized = normalizeTokenUsage(sample, "cursor");
assert(
  normalized.totalTokens === 186344,
  `normalize total=${normalized.totalTokens}`,
);

assert(
  billableInputTokens(sample, "cursor") === 141,
  `billable uncached input=${billableInputTokens(sample, "cursor")}`,
);

console.log("PASS: cursor token volume is inclusive (matches dashboard 3-col sum)");
