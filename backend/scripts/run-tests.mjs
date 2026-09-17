/**
 * Run backend script tests. Dist-backed scripts need `npm run build -w backend`.
 * Usage (repo root): npm test
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<{ file: string; via: "node" | "tsx" }>} */
const tests = [
  { file: "scripts/test-event-ids.mjs", via: "tsx" },
  { file: "scripts/test-port.mjs", via: "tsx" },
  { file: "scripts/test-shutdown.mjs", via: "tsx" },
  { file: "scripts/test-organization.mjs", via: "tsx" },
  { file: "scripts/test-decisions.mjs", via: "tsx" },
  { file: "scripts/test-settings.mjs", via: "node" },
  { file: "scripts/test-project-department.mjs", via: "node" },
  { file: "scripts/test-project-api.mjs", via: "node" },
  { file: "scripts/test-agent-board.mjs", via: "node" },
  { file: "scripts/test-agent-timeline.mjs", via: "node" },
  { file: "scripts/test-ui-version-guard.mjs", via: "node" },
  { file: "scripts/test-run-errors.mjs", via: "node" },
  { file: "scripts/test-token-volume.mjs", via: "node" },
  { file: "scripts/test-queue.mjs", via: "node" },
  { file: "scripts/test-self-check.mjs", via: "node" },
];

const needsDist = tests.some((t) => t.via === "node");
if (needsDist && !fs.existsSync(path.join(backendDir, "dist/store/db.js"))) {
  console.error("Build backend first: npm run build --workspace backend");
  process.exit(1);
}

let failed = 0;
for (const t of tests) {
  const command = t.via === "tsx" ? "npx" : process.execPath;
  const args = t.via === "tsx" ? ["tsx", t.file] : [t.file];
  console.log(`\n--- ${t.file} (${t.via}) ---`);
  const result = spawnSync(command, args, {
    cwd: backendDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL: ${t.file} (exit ${result.status ?? "spawn"})`);
  }
}

if (failed) {
  console.error(`\n${failed} test script(s) failed`);
  process.exit(1);
}
console.log(`\nPASS: ${tests.length} test scripts`);
