/**
 * 网关重启后的会话续接（透明化 PR-6）单测。
 *
 * 机制：cline 的会话 runtime 只在进程内存里，但 SDK 把会话清单 + 完整消息落盘
 * （`~/.cline/data/sessions/<id>/`），`readLiveMessages()` 不驻留时自动回落磁盘。
 * 所以重启后的第一个 run = 读回磁盘历史 → 裁到预算 → `start({ initialMessages })`。
 *
 * 这里只测纯逻辑与安全守卫（provider 里那两行 SDK 调用不碰）：
 *   - `trimSeedHistory`：尾部优先、起点必须是 user、超大单条也要留；
 *   - `recoverSessionAfterRestart`：开关/旧 id/cwd 守卫/空历史/抛错 全部退化回简报路径；
 *   - `agentSuccessionFromEvent`：新 reason `gateway_restart` 要落库（别退化成 mode_change）。
 *
 * Usage: npx tsx backend/scripts/test-restart-resume.mjs   (或 npm test)
 */
import assert from "node:assert/strict";
import {
  DEFAULT_RESUME_SEED_CHARS,
  recoverSessionAfterRestart,
  samePath,
  trimSeedHistory,
} from "../src/providers/cline/restart-resume.ts";
import { agentSuccessionFromEvent } from "../src/gateway/gateway.ts";
import { resolveResumeSeedChars } from "../src/config.ts";

const WORKSPACE = "/Users/gaolei/agent-workspace/agent-abc123";
const msg = (role, text) => ({ role, content: [{ type: "text", text }] });
const chars = (message) => JSON.stringify(message).length;

// ---- 1) 路径守卫：只认同一条路径（去尾部斜杠），空值一律不算 ----
assert.equal(samePath(WORKSPACE, `${WORKSPACE}/`), true);
assert.equal(samePath(` ${WORKSPACE} `, WORKSPACE), true);
assert.equal(samePath(WORKSPACE, "/Users/gaolei/agent-workspace/agent-other"), false);
assert.equal(samePath("", ""), false, "空 cwd 不能算匹配（宁可退回简报）");

// ---- 2) 裁剪：尾部优先 + 起点必须是 user ----
assert.deepEqual(trimSeedHistory([], 1000), { messages: [], droppedMessages: 0, chars: 0 });
const all = [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2")];
const fits = trimSeedHistory(all, 10_000);
assert.equal(fits.messages.length, 3, "装得下就全留");
assert.equal(fits.droppedMessages, 0);
assert.equal(fits.chars, all.reduce((sum, m) => sum + chars(m), 0));

const small = msg("user", "u2");
const tailOnly = trimSeedHistory(all, chars(small));
assert.deepEqual(tailOnly.messages, [small], "预算只够最后一条 → 保最新");
assert.equal(tailOnly.droppedMessages, 2);

// 起点是 assistant → 往前带上最近的那条 user（宁可略超预算，也不让历史「assistant 先开口」）
const four = [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2"), msg("assistant", "a2")];
const aligned = trimSeedHistory(four, chars(four[3]));
assert.deepEqual(aligned.messages, [four[2], four[3]], "只够最后一条时，把前一条 user 一起带上");
assert.equal(aligned.droppedMessages, 2);

// 整段里根本没有 user（脏数据）→ 保持现状，别把自己清空
const noUser = trimSeedHistory([msg("assistant", "a1"), msg("assistant", "a2")], chars(msg("assistant", "a2")));
assert.equal(noUser.messages.length, 1, "没有 user 可对齐就不要退化成空");
assert.equal(noUser.droppedMessages, 1);

// 最新一条自己就超预算：也要留（否则等于没续接）
const huge = msg("user", "x".repeat(50_000));
const hugeOnly = trimSeedHistory([msg("assistant", "old"), huge], 100);
assert.deepEqual(hugeOnly.messages, [huge]);
assert.equal(hugeOnly.droppedMessages, 1);

// 预算 <= 0 = 不续接
assert.deepEqual(trimSeedHistory(all, 0).messages, []);
assert.equal(trimSeedHistory(all, 0).droppedMessages, 3);
assert.deepEqual(trimSeedHistory(all, -1).messages, []);


// ---- 3) 续接编排：任何一步不满足都要「退化回简报」，且绝不越权读别的任务 ----
const history = [msg("user", "u1"), msg("assistant", "a1")];
const deps = (overrides = {}) => {
  const calls = { get: 0, read: 0 };
  return {
    calls,
    deps: {
      getSession: async (id) => {
        calls.get += 1;
        if (overrides.getSession) return overrides.getSession(id);
        return { cwd: WORKSPACE, status: "idle" };
      },
      readMessages: async (id) => {
        calls.read += 1;
        if (overrides.readMessages) return overrides.readMessages(id);
        return overrides.history ?? history;
      },
    },
  };
};
const opts = { previousAgentId: "cls-old", cwd: WORKSPACE, enabled: true, maxChars: 10_000 };

const off = deps();
assert.equal(
  (await recoverSessionAfterRestart(off.deps, { ...opts, enabled: false })).skipped,
  "disabled",
);
assert.equal(off.calls.read, 0, "关掉开关连读都不读");

const fresh = deps();
assert.equal(
  (await recoverSessionAfterRestart(fresh.deps, { ...opts, previousAgentId: "" })).skipped,
  "no_previous_agent",
);
assert.equal(fresh.calls.get, 0, "新任务（没有旧会话）不该去查会话");

const unknown = deps({ getSession: () => undefined });
assert.equal((await recoverSessionAfterRestart(unknown.deps, opts)).skipped, "unknown_session");
assert.equal(unknown.calls.read, 0);

const otherTask = deps({ getSession: () => ({ cwd: "/Users/gaolei/agent-workspace/agent-other" }) });
const mismatch = await recoverSessionAfterRestart(otherTask.deps, opts);
assert.equal(mismatch.skipped, "workspace_mismatch");
assert.equal(mismatch.messages.length, 0);
assert.equal(otherTask.calls.read, 0, "cwd 对不上就不许读历史（防跨任务借上下文）");

const noCwd = deps({ getSession: () => ({ status: "idle" }) });
assert.equal((await recoverSessionAfterRestart(noCwd.deps, opts)).skipped, "workspace_mismatch");

const emptyHistory = deps({ history: [] });
assert.equal((await recoverSessionAfterRestart(emptyHistory.deps, opts)).skipped, "empty_history");

const boom = deps({
  readMessages: () => {
    throw new Error("disk on fire");
  },
});
const errored = await recoverSessionAfterRestart(boom.deps, opts);
assert.equal(errored.skipped, "error");
assert.match(errored.error, /disk on fire/, "错误要带出来，便于事后归因");

const ok = await recoverSessionAfterRestart(deps().deps, opts);
assert.equal(ok.skipped, undefined);
assert.equal(ok.messages.length, 2);
assert.equal(ok.droppedMessages, 0);
assert.equal(ok.chars, history.reduce((sum, m) => sum + chars(m), 0));

const capped = await recoverSessionAfterRestart(deps({ history: four }).deps, {
  ...opts,
  maxChars: chars(four[3]),
});
assert.deepEqual(capped.messages, [four[2], four[3]], "预算内只留尾部（并对齐到 user）");
assert.equal(capped.droppedMessages, 2);

// ---- 4) 事件 → 表行：gateway_restart 不能被吞成 mode_change ----
const successionEvent = {
  eventId: "evt-r1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "cls-new",
  timestamp: "2026-09-20T08:00:00.000Z",
  eventType: "agent_succession",
  payload: {
    provider: "cline",
    fromAgentId: "agent-old",
    toAgentId: "cls-new",
    reason: "gateway_restart",
    fromMode: "agent",
    toMode: "agent",
    seededMessages: 42,
    seededTokens: 9400.7,
  },
};
const row = agentSuccessionFromEvent(successionEvent);
assert.equal(row.reason, "gateway_restart");
assert.equal(row.seededMessages, 42);
assert.equal(row.seededTokens, 9401, "seed 体量四舍五入落库");
assert.equal(
  agentSuccessionFromEvent({
    ...successionEvent,
    payload: { ...successionEvent.payload, reason: "wat" },
  }).reason,
  "mode_change",
  "未知 reason 仍然保守落 mode_change",
);

// ---- 5) 配置口径：默认开 / 垃圾值回默认 / 显式 0 才关 ----
assert.equal(DEFAULT_RESUME_SEED_CHARS, 60_000);
assert.equal(resolveResumeSeedChars(undefined), DEFAULT_RESUME_SEED_CHARS);
assert.equal(resolveResumeSeedChars("  "), DEFAULT_RESUME_SEED_CHARS);
assert.equal(resolveResumeSeedChars("what"), DEFAULT_RESUME_SEED_CHARS, "打错字不能静默关掉续接");
assert.equal(resolveResumeSeedChars("120000"), 120_000);
assert.equal(resolveResumeSeedChars("0"), 0, "显式 0 = 关");

console.log("PASS: 网关重启续接（尾部裁剪 / cwd 守卫 / 退化路径 / 事件与配置口径）");
