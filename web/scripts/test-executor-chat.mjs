/**
 * 「autonomy 创建的 agent 也要能 chat」的界面口径：
 *
 * 1. 输入框在（同一个 ChatInput），但**只收文字**：不出现附件、不出现 Plan/Agent 模式
 *    （执行方没有这些概念 → 不置灰、不占位）；
 * 2. 执行方忙的时候措辞是「排队」（它就是排队，不会被拒）；没有停止按钮（这轮没接停止）；
 * 3. 投递回执只写接口真给了的：`message_id` / 「前面还有几条」/ 状态；拿不到的不写行。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-executor-chat.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";

const { default: ExecutorChat } = await import("../src/components/ExecutorChat.tsx");
const { deliveryReceipt, executorBusy } = await import("../src/autonomy.ts");

const render = (props) =>
  renderToStaticMarkup(React.createElement(ExecutorChat, { taskId: "task-1", ...props }));

// ---- 1) 执行方忙不忙（决定措辞）----
assert.equal(executorBusy("running"), true);
assert.equal(executorBusy("pending"), true);
assert.equal(executorBusy("stopped"), false);
assert.equal(executorBusy("unverified"), false);

// ---- 2) 投递回执：只写它真给了的 ----
assert.equal(
  deliveryReceipt({ executor: true, messageId: 1000010, queueAhead: 0, executorStatus: "pending" }),
  "已投递给执行方（autonomy） · 指令 #1000010 · 马上处理 · 它那边状态 pending"
);
assert.equal(
  deliveryReceipt({ executor: true, messageId: 1000011, queueAhead: 2 }),
  "已投递给执行方（autonomy） · 指令 #1000011 · 前面还有 2 条",
  "排队数 > 0 就说「前面还有 n 条」"
);
assert.equal(
  deliveryReceipt({ executor: true }),
  "已投递给执行方（autonomy）",
  "它没给 id / 排队数 / 状态就都不写（不占位）"
);

// ---- 3) 输入框：文字-only、没有模式选择、没有停止、忙时说排队 ----
{
  const idle = render({ status: "stopped" });
  assert.ok(idle.includes("发给执行方"), "写明这消息是投给执行方的");
  assert.ok(idle.includes("<textarea"), "有输入框");
  assert.ok(idle.includes("send") || idle.includes("Send"), "有发送按钮");
  assert.ok(!idle.includes("btn-attach"), "不显示附件（执行方只收文字）");
  assert.ok(!idle.includes("mode-select"), "不显示 Plan/Agent 模式（它没有这个模式）");
  assert.ok(!idle.includes("btn-stop"), "没有停止按钮（不置灰）");
  assert.ok(idle.includes("发一条指令给执行方"), "空闲时的措辞");

  const busy = render({ status: "running" });
  assert.ok(busy.includes("执行方工作中，消息将排到它后面"), "忙时的措辞 = 排队");
  assert.ok(busy.includes("Queue"), "发送按钮这时是 Queue（进队，不是被拒）");
  assert.ok(!busy.includes("btn-stop"), "忙也没有停止按钮");

  // 对账行（via="executor"）：同一个输入框，但寻址是「它的 task id」
  const viaExecutor = render({ via: "executor", status: "unverified" });
  assert.ok(viaExecutor.includes("<textarea"), "对账行也有输入框");
  assert.ok(viaExecutor.includes("这条任务我们没建过"), "写明这行是纯代理（我们没建过）");
  assert.ok(viaExecutor.includes("task id"), "写明按它的 task id 投递");
  assert.ok(!viaExecutor.includes("本机不跑 run"), "不要用「我们建的任务」那套措辞");
  assert.ok(!viaExecutor.includes("btn-attach"), "对账行同样只收文字");

  // 投递记录 / 回执是发出去之后才有（首帧不写占位）
  assert.ok(!idle.includes("executor-receipt"), "还没发过 → 不写回执");
  assert.ok(!idle.includes("executor-sent"), "还没发过 → 不写投递记录");
  assert.ok(!idle.includes("本页发过的"), "还没发过 → 不写这句提示");
}

console.log(
  "PASS: 执行方 chat 输入框（只收文字 / 忙则排队 / 回执只写真拿到的 / 首帧不占位）"
);
