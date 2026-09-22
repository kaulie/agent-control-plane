/**
 * Unit checks for run error message formatting.
 * Usage: npm run build -w backend && node backend/scripts/test-run-errors.mjs
 */
import {
  classifyRunError,
  formatRunErrorMessage,
  isQuotaError,
  isRetryableSilentAbort,
  upstreamStatusCode,
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

// 上游只回 gRPC 状态码、没有文案（Cursor 新版 API）→ 必须归到「哪一类 + 下一步」。
// 2026-09-22 实测：新账号下只有 grok-4.7 报 `[resource_exhausted] Error`（grok-4.6/Auto 正常），
// 之前落成 kind=other，用户只看到 `Error · kind=other`，判不出原因。
const exhaustedRaw = "[resource_exhausted] Error";
assert(
  upstreamStatusCode(exhaustedRaw) === "resource_exhausted",
  "resource_exhausted code parsed",
);
assert(
  classifyRunError(exhaustedRaw).kind === "quota",
  "resource_exhausted -> quota kind",
);
assert(
  formatRunErrorMessage(exhaustedRaw).includes("Auto") &&
    formatRunErrorMessage(exhaustedRaw).includes("CURSOR_API_KEY"),
  "resource_exhausted message actionable (Auto + which key)",
);
assert(
  formatRunErrorMessage(exhaustedRaw) !== exhaustedRaw,
  "resource_exhausted raw code not passed through",
);

const unavailableRaw = "[unavailable] Error";
assert(
  upstreamStatusCode(unavailableRaw) === "unavailable",
  "unavailable code parsed",
);
assert(
  classifyRunError(unavailableRaw).kind === "network",
  "unavailable -> network kind",
);
assert(
  formatRunErrorMessage(unavailableRaw).includes("稍后重试"),
  "unavailable message actionable",
);
assert(
  formatRunErrorMessage("[deadline_exceeded] Error").includes("Auto"),
  "deadline_exceeded message actionable",
);

// 未收录的上游码：原文照旧，但补上下文；纯文本错误不受影响。
assert(
  formatRunErrorMessage("[weird_code] Error").startsWith("[weird_code] Error（"),
  "unknown upstream code annotated",
);
assert(
  upstreamStatusCode("Something else") === undefined,
  "no code for plain text",
);

console.log("PASS: run error formatting");
