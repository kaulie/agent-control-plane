/**
 * Unit checks for run error message formatting.
 * Usage: npm run build -w backend && node backend/scripts/test-run-errors.mjs
 */
import {
  classifyRunError,
  formatRunErrorMessage,
  isQuotaError,
  isRetryableSilentAbort,
} from "../dist/run-errors.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  formatRunErrorMessage("[unknown] [canceled] This operation was aborted") ===
    "任务中断：Cursor 连接在无响应后被取消（通常为网络/API 空转，并非用户点了停止）",
  "abort message localized",
);
assert(
  classifyRunError("[unknown] [canceled] This operation was aborted").kind ===
    "sdk_aborted",
  "abort kind",
);
assert(
  formatRunErrorMessage("interrupted (server restart)") ===
    "任务因服务重启中断",
  "restart message localized",
);
assert(
  classifyRunError("interrupted (server restart)").kind === "server_restart",
  "restart kind",
);
assert(
  formatRunErrorMessage("Network request failed").includes("网络异常"),
  "network message localized",
);
assert(formatRunErrorMessage("") === "未知错误", "empty -> 未知错误");
assert(formatRunErrorMessage("Something else") === "Something else", "passthrough");

// 上游额度用尽（Cursor「out of usage」）→ 可操作中文。
// 不识别的话英文原文会被透传，用户看到「额度不够」却以为自己更新账户后会好。
const quotaRaw =
  "Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
assert(classifyRunError(quotaRaw).kind === "quota", "quota kind");
assert(isQuotaError(quotaRaw) === true, "quota matcher hits cursor out-of-usage");
assert(
  formatRunErrorMessage(quotaRaw).includes("额度") &&
    formatRunErrorMessage(quotaRaw).includes("Auto"),
  "quota message localized + actionable (points to Auto)",
);
assert(isQuotaError("Network request failed") === false, "quota matcher ignores network");
assert(isQuotaError("already has active run") === false, "quota matcher ignores busy");
assert(
  isRetryableSilentAbort("This operation was aborted", {
    toolCalls: 0,
    modelCalls: 0,
  }) === true,
  "silent abort retryable",
);
assert(
  isRetryableSilentAbort("This operation was aborted", {
    toolCalls: 1,
    modelCalls: 0,
  }) === false,
  "abort after tools not retryable",
);

console.log("PASS: run error formatting");
