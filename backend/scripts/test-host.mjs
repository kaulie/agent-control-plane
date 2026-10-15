/**
 * Startup listen host: HOST wins, blank / whitespace-broken values fall back
 * to 0.0.0.0 so a fresh process accepts traffic on every IPv4 interface.
 *
 * Usage: npx tsx backend/scripts/test-host.mjs   (or: npm test)
 */
import assert from "node:assert/strict";
import { DEFAULT_HOST, resolveHost } from "../src/config.ts";

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

check("no env → all interfaces", () => {
  assert.equal(resolveHost({}), DEFAULT_HOST);
  assert.equal(DEFAULT_HOST, "0.0.0.0");
});

check("explicit HOST is kept", () => {
  assert.equal(resolveHost({ HOST: "127.0.0.1" }), "127.0.0.1");
  assert.equal(resolveHost({ HOST: "192.168.1.5" }), "192.168.1.5");
  assert.equal(resolveHost({ HOST: "::" }), "::");
});

check("surrounding whitespace is trimmed", () => {
  assert.equal(resolveHost({ HOST: "  0.0.0.0  " }), "0.0.0.0");
});

check("blank values fall back", () => {
  assert.equal(resolveHost({ HOST: "" }), DEFAULT_HOST);
  assert.equal(resolveHost({ HOST: "   " }), DEFAULT_HOST);
  assert.equal(resolveHost({ HOST: undefined }), DEFAULT_HOST);
});

check("whitespace inside the token is rejected", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(resolveHost({ HOST: "0.0.0.0 extra" }), DEFAULT_HOST);
    assert.equal(resolveHost({ HOST: "127.0.0.1\nHOST=evil" }), DEFAULT_HOST);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /ignoring invalid HOST/);
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: host resolution");
