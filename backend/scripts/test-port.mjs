/**
 * Startup port: SERVICE_PORT wins, PORT stays as the legacy fallback, and an
 * empty / invalid value falls back to the default (4211) instead of NaN.
 *
 * Usage: npx tsx backend/scripts/test-port.mjs   (or: npm test)
 */
import assert from "node:assert/strict";
import {
  DEFAULT_PORT,
  resolvePort,
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

check("no env → default", () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 4211);
});

check("SERVICE_PORT only", () => {
  assert.equal(resolvePort({ SERVICE_PORT: "4212" }), 4212);
});

check("SERVICE_PORT wins over PORT", () => {
  assert.equal(resolvePort({ SERVICE_PORT: "4300", PORT: "4212" }), 4300);
});

check("legacy PORT still works", () => {
  assert.equal(resolvePort({ PORT: "4212" }), 4212);
});

check("blank values are ignored", () => {
  assert.equal(resolvePort({ SERVICE_PORT: "", PORT: "" }), DEFAULT_PORT);
  assert.equal(resolvePort({ SERVICE_PORT: "   ", PORT: "4213" }), 4213);
});

check("surrounding whitespace is trimmed", () => {
  assert.equal(resolvePort({ SERVICE_PORT: " 4214 " }), 4214);
});

check("invalid values fall through, never NaN", () => {
  assert.equal(resolvePort({ SERVICE_PORT: "abc" }), DEFAULT_PORT);
  assert.equal(resolvePort({ SERVICE_PORT: "abc", PORT: "4215" }), 4215);
  assert.equal(resolvePort({ SERVICE_PORT: "0" }), DEFAULT_PORT);
  assert.equal(resolvePort({ SERVICE_PORT: "-1" }), DEFAULT_PORT);
  assert.equal(resolvePort({ SERVICE_PORT: "70000" }), DEFAULT_PORT);
  assert.equal(resolvePort({ SERVICE_PORT: "4212.5" }), DEFAULT_PORT);
  assert.ok(Number.isInteger(resolvePort({ SERVICE_PORT: "abc" })));
});

check("process.env is the default source", () => {
  const before = process.env.SERVICE_PORT;
  process.env.SERVICE_PORT = "4310";
  try {
    assert.equal(resolvePort(), 4310);
  } finally {
    if (before === undefined) delete process.env.SERVICE_PORT;
    else process.env.SERVICE_PORT = before;
  }
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: port resolution");
