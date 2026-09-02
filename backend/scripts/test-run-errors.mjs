/**
 * Unit checks for run error message formatting.
 * Usage: npm run build -w backend && node backend/scripts/test-run-errors.mjs
 */
import { formatRunErrorMessage } from "../dist/run-errors.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  formatRunErrorMessage("[unknown] [canceled] This operation was aborted") ===
    "任务被中断（用户停止或服务重启）",
  "abort message localized",
);
assert(
  formatRunErrorMessage("interrupted (server restart)") ===
    "任务因服务重启中断",
  "restart message localized",
);
assert(formatRunErrorMessage("") === "未知错误", "empty -> 未知错误");
assert(formatRunErrorMessage("Something else") === "Something else", "passthrough");

console.log("PASS: run error formatting");
