/**
 * Agent concurrency cap: `AGENT_MAX_CONCURRENT_RUNS` resolves to the default 4
 * when unset, and a blank / malformed / non-positive value falls back to the
 * default instead of NaN (NaN would silently lift the cap entirely).
 *
 * Usage: npx tsx backend/scripts/test-max-concurrent-runs.mjs   (or: npm test)
 */
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  resolveMaxConcurrentRuns,
} from "../src/config.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

check("default is 4", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_RUNS, 4);
  assert.equal(resolveMaxConcurrentRuns({}), 4);
});

check("explicit value wins", () => {
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "2" }), 2);
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "8" }), 8);
});

check("surrounding whitespace is trimmed", () => {
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: " 6 " }), 6);
});

check("blank / invalid / non-positive fall back, never NaN", () => {
  const result = resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "abc" });
  assert.equal(result, DEFAULT_MAX_CONCURRENT_RUNS);
  assert.ok(Number.isInteger(result));
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "" }), 4);
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "   " }), 4);
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "0" }), 4);
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "-3" }), 4);
  assert.equal(resolveMaxConcurrentRuns({ AGENT_MAX_CONCURRENT_RUNS: "2.5" }), 4);
});

console.log(failed ? `\n${failed} check(s) failed` : "\ntest-max-concurrent-runs: ok");
process.exit(failed ? 1 : 0);
