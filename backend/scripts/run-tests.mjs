/**
 * Run backend script tests. Dist-backed scripts need `npm run build -w backend`.
 * Usage (repo root): npm test
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<{ file: string; via: "node" | "tsx"; args?: string[] }>} */
const tests = [
  { file: "scripts/test-event-ids.mjs", via: "tsx" },
  { file: "scripts/test-port.mjs", via: "tsx" },
  { file: "scripts/test-shutdown.mjs", via: "tsx" },
  { file: "scripts/test-organization.mjs", via: "tsx" },
  { file: "scripts/test-decisions.mjs", via: "tsx" },
  { file: "scripts/test-settings.mjs", via: "node" },
  { file: "scripts/test-project-department.mjs", via: "node" },
  { file: "scripts/test-project-api.mjs", via: "node" },
  { file: "scripts/test-billing-api.mjs", via: "node" },
  { file: "scripts/test-agent-board.mjs", via: "node" },
  { file: "scripts/test-agent-timeline.mjs", via: "node" },
  { file: "scripts/test-ui-version-guard.mjs", via: "node" },
  { file: "scripts/test-run-errors.mjs", via: "node" },
  { file: "scripts/test-token-volume.mjs", via: "node" },
  { file: "scripts/test-billing.mjs", via: "tsx" },
  { file: "scripts/test-context-size.mjs", via: "tsx" },
  { file: "scripts/test-transparency.mjs", via: "tsx" },
  { file: "scripts/test-fork-api.mjs", via: "tsx" },
  { file: "scripts/test-task-intent.mjs", via: "tsx" },
  { file: "scripts/test-context-rotation.mjs", via: "tsx" },
  { file: "scripts/test-digest.mjs", via: "tsx" },
  { file: "scripts/test-queue.mjs", via: "node" },
  { file: "scripts/test-self-check.mjs", via: "node" },
  // 时间线的点线几何 / SVG 是纯前端逻辑，放在 web/src，直接用 tsx 跑源码
  // （不需要前端构建）。渲染检查要显式指向 web 的 tsconfig，否则 JSX 走的是
  // backend 的经典 runtime，组件里没 import React 就会炸。
  { file: "../web/scripts/test-timeline-line.mjs", via: "tsx" },
  { file: "../web/scripts/test-board-format.mjs", via: "tsx" },
  { file: "../web/scripts/test-usage-cost.mjs", via: "tsx" },
  { file: "../web/scripts/test-context-format.mjs", via: "tsx" },
  { file: "../web/scripts/test-timeline-events.mjs", via: "tsx" },
  // 任务意图（类型标签 + 系统投递卡片）前端口径
  {
    file: "../web/scripts/test-task-intent-ui.mjs",
    via: "tsx",
    args: ["--tsconfig", "../web/tsconfig.json"],
  },
  {
    file: "../web/scripts/test-timeline-render.mjs",
    via: "tsx",
    args: ["--tsconfig", "../web/tsconfig.json"],
  },
];

const needsDist = tests.some((t) => t.via === "node");
if (needsDist && !fs.existsSync(path.join(backendDir, "dist/store/db.js"))) {
  console.error("Build backend first: npm run build --workspace backend");
  process.exit(1);
}

let failed = 0;
for (const t of tests) {
  const command = t.via === "tsx" ? "npx" : process.execPath;
  const args =
    t.via === "tsx"
      ? ["tsx", ...(t.args ?? []), t.file]
      : [...(t.args ?? []), t.file];
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
