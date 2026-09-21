/**
 * 阻塞态交互口径（`ExecutorBlockedPanel` + `autonomy.ts` 的 `blockedView`）。
 *
 * 覆盖：
 * 1) 分类：来自它自己的 `status` / `need.type`（approval / decision / input / external / error /
 *    stopped / unverified），非阻塞态没有面板（返回 null）；
 * 2) 「它在等什么」：`need.description` 全文优先；它没填 need 就退到 `reason`，并**标明来源**；
 * 3) 选项：**只认 `need.options` 里结构化的**；散文里的 `(1) … (2) …` **不猜**（不许变成选项）；
 * 4) 面板渲染：选项按 1..N 列成**单选**（点中先选中），**【确认】才投递**；没选中时确认不可用；
 *    没有选项时不出现选项块；自由输入永远在；
 * 5) 投递通道：面板【确认】交给当前挂着的通道（同一实现、同一回执），空串不发、没有通道就
 *    明说没投、通道抛错按原文回。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-executor-blocked-ui.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";
const { blockedView, needOptions, linkLabel, linksIn, MAX_NEED_OPTIONS } =
  await import("../src/autonomy.ts");
const { default: ExecutorBlockedPanel } = await import("../src/components/ExecutorBlockedPanel.tsx");
const { onExecutorReply, submitExecutorReply } = await import("../src/executorReply.ts");

const PR = "https://github.com/kaulie/agent-control-plane/pull/117";
const detail = (status, plan) => ({
  task_id: "task-2c438baf5499b592",
  status,
  plans: [
    {
      plan_id: 13,
      cycle: 2,
      decision_type: plan.decision ?? "need_input",
      reason: plan.reason ?? "",
      need: plan.need ?? "{}",
      step_count: 0,
      executed: 0,
    },
  ],
});
const json = (o) => JSON.stringify(o);

// ---- 1) 分类：approval / decision / input / external / error / stopped / unverified ----
const approval = blockedView(
  detail("need_input", {
    need: json({
      type: "approval",
      description: `The web-cursor feature is implemented and open as PR ${PR}, but C2 requires a merge. A human must review, approve and merge.`,
    }),
    reason: "long rationale …",
  }),
);
assert.equal(approval.kind, "approval");
assert.equal(approval.kindLabel, "等你拍板");
assert.equal(approval.needType, "approval");
assert.equal(approval.askSource, "need", "有 need.description 时，用它，不用 reason");
assert.ok(approval.ask.includes("A human must review, approve and merge"), "ask 是 need.description 全文");
assert.ok(approval.basis.includes("need.type=approval"), "依据要照实说它标了什么");
assert.equal(approval.links.length, 1);
assert.equal(approval.links[0].url, PR);
assert.equal(approval.links[0].label, "kaulie/agent-control-plane PR #117");

const decision = blockedView(
  detail("need_input", {
    need: json({ type: "decision", description: "Two external inputs are required. (1) Scope decision: … (2) Approval: …" }),
  }),
);
assert.equal(decision.kind, "decision");
assert.equal(decision.kindLabel, "等你定");
assert.deepEqual(decision.options, [], "散文里的 (1)(2) 不是结构化选项 —— 不猜");

const input = blockedView(detail("need_input", { reason: "it needs something from you" }));
assert.equal(input.kind, "input");
assert.equal(input.askSource, "reason", "它没填 need 就退到 reason，并且要知道这来自 reason");
assert.equal(input.ask, "it needs something from you");

assert.equal(blockedView(detail("blocked", { decision: "blocked" })).kind, "external");
assert.equal(blockedView(detail("failed", {})).kind, "error");
assert.equal(blockedView(detail("stopped", {})).kind, "stopped");
assert.equal(blockedView(detail("unverified", {})).kind, "unverified");
assert.ok(blockedView(detail("stopped", {})).basis.includes("stopped"), "依据里带上原始状态");

// 非阻塞态：没有面板
for (const s of ["pending", "running", "completed"]) {
  // 这些状态配的是普通 plan 决策（不是 need_input / blocked）
  assert.equal(blockedView(detail(s, { decision: "plan" })), null, `${s} 不是阻塞态 → 不渲染面板`);
}
assert.equal(blockedView(null), null, "没有 detail 也不渲染");

// ---- 2) 它没说明在等什么：不编，明确说它没说 ----
const silent = blockedView(detail("blocked", { decision: "blocked" }));
assert.equal(silent.ask, "");
assert.equal(silent.askSource, "none");

// ---- 3) 选项：只认 need.options（去空、去重、封顶）----
const withOptions = blockedView(
  detail("need_input", {
    need: json({
      type: "approval",
      description: `PR ${PR} is open; C2 needs a merge.`,
      options: ["Merge it now", "  ", "Merge it now", "Ask for changes first", 42, "Stop here"],
    }),
  }),
);
assert.deepEqual(
  withOptions.options,
  ["Merge it now", "Ask for changes first", "Stop here"],
  "只留非空字符串、去重、非字符串丢掉",
);
assert.equal(withOptions.summaryLine.includes("3 个选项"), true);
assert.deepEqual(needOptions(json({ options: Array.from({ length: 20 }, (_, i) => `o${i}`) })).length, MAX_NEED_OPTIONS);
assert.deepEqual(needOptions("{}"), []);
assert.deepEqual(needOptions(undefined), []);
assert.deepEqual(needOptions("not json"), []);

// ---- 4) 面板渲染 ----
const html = renderToStaticMarkup(React.createElement(ExecutorBlockedPanel, { detail: detail("need_input", {
  need: json({ type: "approval", description: `PR ${PR} is open; C2 needs a merge.`, options: ["Merge it now", "Ask for changes first"] }),
  reason: "long rationale",
}) }));
assert.ok(html.includes("blocked-panel is-approval"));
assert.ok(html.includes("等你拍板"));
assert.ok(html.includes("blocked-ask"), "它在等什么是面板主体");
assert.ok(html.includes("need.description 原文"), "标明这段话来自 need");
assert.ok(html.includes(`href="${PR}"`), "证据链接可点");
assert.ok(html.includes("blocked-option-idx") && html.includes(">1.<") && html.includes(">2.<"), "选项按 1..N 列（编号只是界面的事）");
assert.equal((html.match(/role="radio"/g) ?? []).length, 2, "选项是单选（radiogroup）");
assert.ok(html.includes('aria-checked="false"'), "未选中时 aria-checked=false");
assert.ok(html.includes("blocked-confirm"), "要有【确认】按钮");
assert.ok(/class="blocked-confirm"[^>]*disabled/.test(html), "没选之前【确认】不可用");
assert.ok(html.includes("先点一个选项（不用输入编号）"), "提示不用输入编号");
assert.ok(!html.includes("data-prefill"), "不再往输入框塞字（用户直接确认）");
assert.ok(html.includes("都不合适？也可以直接写在下面的输入框里（你自己的意见）。"), "自由输入永远在");
assert.ok(html.includes("blocked-reason"), "reason 折叠可看");

const noOptions = renderToStaticMarkup(
  React.createElement(ExecutorBlockedPanel, { detail: detail("need_input", { reason: "needs your input" }) }),
);
assert.ok(!noOptions.includes("blocked-options"), "它没给选项就不出现选项块（更不编选项）");
assert.ok(!noOptions.includes("blocked-confirm"), "没有选项就没有【确认】按钮");
assert.ok(noOptions.includes("blocked-ask") && noOptions.includes("needs your input"));
assert.ok(noOptions.includes("它不是让你选"), "说清这里只走自由输入");

const notBlocked = renderToStaticMarkup(
  React.createElement(ExecutorBlockedPanel, { detail: detail("running", { decision: "plan" }) }),
);
assert.equal(notBlocked, "", "非阻塞态：面板整块不渲染");

// ---- 5) 投递通道：面板【确认】交给当前挂着的通道（而不是自己发一遍）----
// 没有通道（输入框未挂载）→ 明说没投，不假装已投
const noChannel = await submitExecutorReply("Merge it now");
assert.equal(noChannel.ok, false);
assert.match(noChannel.error, /没有投递通道/, "没挂通道要说清没投");

const got = [];
const off = onExecutorReply(async (text) => {
  got.push(text);
  return { ok: true, receipt: `已投递 · 指令 #7` };
});
const delivered = await submitExecutorReply("  Ask for changes first  ");
assert.deepEqual(got, ["Ask for changes first"], "交给通道时去掉首尾空白");
assert.deepEqual(delivered, { ok: true, receipt: "已投递 · 指令 #7" }, "把通道的回执原样带回来");
const blank = await submitExecutorReply("   ");
assert.equal(blank.ok, false, "空消息不投递");
assert.equal(got.length, 1, "空消息不进通道");
off();
const afterOff = await submitExecutorReply("after unsubscribe");
assert.equal(afterOff.ok, false, "退订后不再有通道");

// 通道失败（404 / 503 的原文）照原样回给面板
const off2 = onExecutorReply(async () => {
  throw new Error("执行方不可达（503）");
});
const failed = await submitExecutorReply("Merge it now");
assert.deepEqual(failed, { ok: false, error: "执行方不可达（503）" }, "失败原文回给面板，不吞");
off2();

// ---- 链接标签 ----
assert.equal(linkLabel(PR), "kaulie/agent-control-plane PR #117");
assert.equal(linkLabel("http://127.0.0.1:4220/api/pipelines/pipeline-abc"), "流水线 pipeline-abc");
assert.equal(linkLabel("http://127.0.0.1:4220/api/deployments/deployment-deadbeef"), "部署 deployment-deadbeef");
assert.deepEqual(
  linksIn(`see ${PR}. and ${PR}`).length,
  1,
  "同一个链接只列一次（尾巴标点也去掉）",
);

console.log("✅ executor blocked UI OK");
