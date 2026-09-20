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
  isRealUserTurn,
  recoverSessionAfterRestart,
  samePath,
  sanitizeSeedHistory,
  trimSeedHistory,
} from "../src/providers/cline/restart-resume.ts";
import { agentSuccessionFromEvent } from "../src/gateway/gateway.ts";
import { resolveResumeSeedChars } from "../src/config.ts";
import { isToolPairingError } from "../src/run-errors.ts";

const WORKSPACE = "/Users/gaolei/agent-workspace/agent-abc123";
const msg = (role, text) => ({ role, content: [{ type: "text", text }] });
const chars = (message) => JSON.stringify(message).length;

// ---- 0) 线上事故的形状（2026-09-20）：cline 把工具结果也记成 role: "user" ----
// 只按 role 判断的话，尾部裁剪的起点会落在 tool_result 上，seed 首条就是「工具结果」，
// 上游按 OpenAI 风格翻成 role=tool 却没有前置工具调用 → 400（两个任务被卡死）。
const toolUse = (id, name = "run_commands") => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
});
const toolResult = (id, name = "run_commands") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, name, content: "ok" }],
});
const prompt = (text) => ({ role: "user", content: [{ type: "text", text }] });

assert.equal(isRealUserTurn(prompt("hi")), true);
assert.equal(isRealUserTurn(toolResult("call_1")), false, "工具结果不是用户发言");
assert.equal(isRealUserTurn({ role: "user", content: "hi" }), true, "字符串内容算用户发言");
assert.equal(isRealUserTurn({ role: "user", content: "   " }), false, "空字符串不算");
assert.equal(isRealUserTurn({ role: "user", content: [] }), false, "空内容不算");
assert.equal(isRealUserTurn(toolUse("call_1")), false);
assert.equal(
  isRealUserTurn({ role: "user", content: [{ type: "text", text: "看下" }, { type: "tool_result", tool_use_id: "call_1" }] }),
  true,
  "夹了文字的工具结果仍算用户发言",
);

// 真实形状：一次用户提问 + 两轮工具调用；预算只够最后两条（原本正好落在工具结果上）
const turn = [
  prompt("把并发数调到 4"),
  toolUse("call_a"),
  toolResult("call_a"),
  toolUse("call_b"),
  toolResult("call_b"),
];
// 修好之后：起点被拉回到真正的 user prompt（宁可略超预算），seed 首条绝不再是工具结果
const alignedTurn = trimSeedHistory(turn, chars(turn[4]) + chars(turn[3]));
assert.equal(alignedTurn.messages[0], turn[0], "起点必须拉回到真实用户发言（以前会停在 tool_result）");
assert.equal(alignedTurn.messages.length, 5);
assert.equal(alignedTurn.droppedMessages, 0);

// ---- 0b) sanitizeSeedHistory：把 seed 修成 provider 一定收的样子 ----
// 孤儿工具结果（配对的 tool_use 被预算裁掉了）→ 块被剔掉；剔完只剩 assistant 开头 → 整段不可用
const orphanSeed = [toolResult("call_a"), toolUse("call_b"), toolResult("call_b")];
const sanitizedOrphan = sanitizeSeedHistory(orphanSeed);
assert.equal(sanitizedOrphan.droppedToolBlocks, 1);
assert.equal(sanitizedOrphan.messages.length, 0, "首条不是真实用户发言 → 宁可退化成只注简报");

// 真实用户发言在前面时：只丢孤儿，其余原样保留
const mixedSeed = [prompt("u1"), toolResult("call_a"), toolUse("call_b"), toolResult("call_b")];
const sanitizedMixed = sanitizeSeedHistory(mixedSeed);
assert.deepEqual(
  sanitizedMixed.messages.map((m) => m.content[0].type),
  ["text", "tool_use", "tool_result"],
  "孤儿工具结果被丢掉，配对的工具调用/结果留着",
);
assert.equal(sanitizedMixed.droppedToolBlocks, 1);
assert.equal(sanitizedMixed.droppedMessages, 1);

// 尾巴停在没跑完的工具调用上（turn 中途重启）→ 剔掉那个 tool_use 块，消息本身留着
const danglingTail = [
  prompt("u1"),
  {
    role: "assistant",
    content: [{ type: "thinking", thinking: "想" }, { type: "tool_use", id: "call_z", name: "run_commands" }],
  },
];
const sanitizedTail = sanitizeSeedHistory(danglingTail);
assert.equal(sanitizedTail.droppedToolBlocks, 1);
assert.equal(sanitizedTail.messages.length, 2);
assert.deepEqual(sanitizedTail.messages[1].content.map((b) => b.type), ["thinking"]);

// 干净的历史必须原样返回（不许「顺手修一修」）
const cleanSeed = sanitizeSeedHistory([prompt("u1"), toolUse("call_a"), toolResult("call_a"), prompt("u2")]);
assert.equal(cleanSeed.droppedToolBlocks, 0);
assert.equal(cleanSeed.droppedMessages, 0);
assert.equal(cleanSeed.messages.length, 4);
assert.deepEqual(sanitizeSeedHistory([]), { messages: [], droppedMessages: 0, droppedToolBlocks: 0 });

// ---- 0c) 上游 400 的识别（用来判定「这段历史不能用」）----
assert.equal(
  isToolPairingError("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"),
  true,
  "DeepSeek 原文要认出来",
);
assert.equal(
  isToolPairingError("Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'."),
  true,
  "OpenAI 的拼写（preceeding）也要认",
);
assert.equal(
  isToolPairingError("tool_result blocks must have a corresponding tool_use block"),
  true,
  "Anthropic 风格的等价错误",
);
assert.equal(isToolPairingError("Service is too busy."), false);
assert.equal(isToolPairingError(""), false);
assert.equal(isToolPairingError(undefined), false);
assert.equal(isToolPairingError("tool_calls 参数拼错了"), false, "不能见 tool_calls 就当配对错误");

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

// 整段里根本没有**真实用户发言**（脏数据）→ 裁剪层先保持现状，由 sanitizeSeedHistory
// 判定「不可用」（它会把这种 seed 清空，调用方退化成只注简报 —— 见下面的编排测试）
const noUser = trimSeedHistory([msg("assistant", "a1"), msg("assistant", "a2")], chars(msg("assistant", "a2")));
assert.equal(noUser.messages.length, 1, "裁剪层没有 user 可对齐就不要自己清空");
assert.equal(noUser.droppedMessages, 1);
assert.equal(sanitizeSeedHistory(noUser.messages).messages.length, 0, "首条不是真实用户发言 → 契约层判不可用");

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

// 事故复现（task-48cc978355744c55）：磁盘历史很长，预算只够尾部 → 起点落在工具结果上。
// 修好之后：seed 首条必须是真实用户发言、工具块必须配对，且剔了什么要能报出来。
const longHistory = [
  prompt("第一轮提问"),
  toolUse("call_a"),
  toolResult("call_a"),
  prompt("第二轮提问"),
  toolUse("call_b"),
  toolResult("call_b"),
];
const poisonBudget = chars(longHistory[5]) + chars(longHistory[4]);
// 修好之后：起点从「停在 call_b 的工具结果上」拉回到最近的真实用户发言（第二轮提问），
// 因此 seed 里的工具调用/结果始终成对。（修复前 seed 首条就是 tool_result → 上游 400。）
const poisonRaw = trimSeedHistory(longHistory, poisonBudget);
assert.equal(isRealUserTurn(poisonRaw.messages[0]), true, "起点必须是真实用户发言");
const recovered = await recoverSessionAfterRestart(deps({ history: longHistory }).deps, {
  ...opts,
  maxChars: poisonBudget,
});
assert.equal(recovered.skipped, undefined);
assert.equal(isRealUserTurn(recovered.messages[0]), true, "seed 首条必须是真实用户发言");
assert.deepEqual(
  recovered.messages.map((m) => m.content[0].type),
  ["text", "tool_use", "tool_result"],
  "起点被拉回到「第二轮提问」，整段工具调用/结果都在里面（配对完整）",
);
assert.equal(recovered.droppedToolBlocks, undefined, "这条路径不需要剔任何工具块");

// 就算磁盘历史本身就是坏的（孤儿工具结果开头），也要修好、并且报出剔了什么
const brokenHistory = [toolResult("call_gone"), toolUse("call_live"), toolResult("call_live"), prompt("后来的一次提问")];
const recoveredBroken = await recoverSessionAfterRestart(deps({ history: brokenHistory }).deps, opts);
assert.equal(recoveredBroken.droppedToolBlocks, 1, "孤儿工具结果要被剔掉并上报");
assert.equal(recoveredBroken.droppedSeedMessages, 3, "剔完之后首条仍是 assistant → 前面的坏段整段丢掉");
assert.deepEqual(
  recoveredBroken.messages.map((m) => m.content[0].type),
  ["text"],
  "只剩下真实用户发言",
);

// 对齐到 turn 边界后可能远超字符预算 —— 用模型窗口做硬兜底（`maxSeedTokens`）：
// 连窗口都装不下的 seed 宁可不要（否则又是一次必然的 400）。
const tooWide = await recoverSessionAfterRestart(deps({ history: longHistory }).deps, {
  ...opts,
  maxSeedTokens: 10,
});
assert.equal(tooWide.skipped, "over_window");
assert.equal(tooWide.messages.length, 0);

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
