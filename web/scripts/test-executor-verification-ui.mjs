/**
 * 「验证」section 的口径（`autonomy.ts` 的 `verificationView` + `ExecutorVerification`）。
 *
 * 覆盖：
 * 1) 三种「没有」分开说：接口没这个字段（从没判过）/ 契约空 / 有契约没判定；
 * 2) 契约：判据原文里的 requirement、证据槽、期望；原文是**字符串**或**对象**都认；
 * 3) 判定：结果三态（pass / fail / inconclusive + 别的照原文）、最近一轮的结论、
 *    每条判据最近一次判定与次数；
 * 4) 渲染：`aria-label="验证"` 的独立 section、契约行、结果徽章、判定记录；首帧不画。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-executor-verification-ui.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.__APP_VERSION__ = "0.0.0-test";
const { verificationView } = await import("../src/autonomy.ts");
const { default: VerificationSection } =
  await import("../src/components/ExecutorVerification.tsx");

const html = (detail) =>
  renderToStaticMarkup(React.createElement(VerificationSection, { detail }));
const text = (markup) =>
  markup
    .replace(/<[^>]+>/g, "\u0001")
    .split("\u0001")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" | ");

// ---- 1) 首帧 / 没有字段 -----------------------------------------------------------
assert.equal(verificationView(null).loaded, false, "首帧没读到 → loaded false");
assert.equal(html(null), "", "首帧不画（免得先闪一句「没判过」再变）");

const noField = verificationView({ status: "running", plans: [] });
assert.equal(noField.present, false);
assert.equal(noField.tone, "none");
assert.match(noField.headline, /还没判过/, "接口没这个字段 = 引擎从没判过");
const noFieldHtml = html({ status: "running", plans: [] });
assert.ok(noFieldHtml.includes('aria-label="验证"'), "即使没判过也占一节（说清没判过）");
assert.ok(!noFieldHtml.includes("auto-verify-contract"), "没字段时不画契约列表");

// ---- 2) 真实形态的 payload（criterion 是 JSON **字符串**）------------------------
const criterion = (name, requirement, slot, expect) =>
  JSON.stringify({ name, requirement, evidence: { source: slot }, expect });
const verdict = (id, cycle, crit, result, extra = {}) => ({
  id,
  plan_id: 4,
  cycle,
  criterion: crit,
  result,
  method: extra.method ?? "declared:software_development.code_edit",
  evidence: JSON.stringify({ slot: extra.slot ?? "step:report.output.summary", reference: "step:report" }),
  expected: extra.expected ?? "exists = true",
  observed: extra.observed ?? "the file is there",
  reason: extra.reason ?? "",
  created_at: "2026-09-21T08:00:00Z",
});

const rich = {
  status: "unverified",
  verification: {
    contract: [
      { idx: 1, name: "C1", criterion: criterion("C1", "A report is produced", "step:report.output.summary", { exists: true }) },
      { idx: 2, name: "C2", criterion: criterion("C2", "The change is landed (merged)", "step:land.output.merged", { field: "merged", equals: "true" }) },
    ],
    verdicts: [
      verdict(1, 2, "C1", "pass"),
      verdict(2, 2, "C2", "inconclusive", { method: "-", reason: "no authoritative source answers for this slot", slot: "step:land.output.merged" }),
      verdict(3, 4, "C1", "pass", { observed: "the report exists" }),
      verdict(4, 4, "C2", "inconclusive", { method: "registry:git.merge", reason: "no step named land ran", observed: "merged = false", expected: "merged = true", slot: "step:land.output.merged" }),
    ],
  },
};

const view = verificationView(rich);
assert.equal(view.present, true, "有字段 → present true");
assert.equal(view.counts.total, 4);
assert.deepEqual(
  { pass: view.counts.pass, fail: view.counts.fail, inc: view.counts.inconclusive },
  { pass: 2, fail: 0, inc: 2 },
);
assert.equal(view.verdicts[0].id, 4, "判定记录最新在前");
assert.equal(view.tone, "inconclusive", "最近一轮没过（inconclusive）→ 整体 inconclusive");
assert.match(view.headline, /最近一轮（cycle 4）没过/);
assert.match(view.headline, /C2 inconclusive/, "结论里点名是哪条判据没过");
assert.match(view.headline, /只有全 pass 才算数/);

// 契约：requirement / 证据槽 / 期望 都从**判据原文**里解析出来
assert.equal(view.contract.length, 2);
const [c1, c2] = view.contract;
assert.equal(c1.name, "C1");
assert.equal(c1.requirement, "A report is produced");
assert.equal(c1.slot, "step:report.output.summary");
assert.equal(c1.expect, "exists=true");
assert.equal(c1.last?.id, 3, "C1 的最近一次判定是 id 3（不是更早的 id 1）");
assert.equal(c1.passes, 2, "C1 判过两次 pass");
assert.equal(c2.fails, 0);
assert.equal(c2.inconclusives, 2, "C2 两次都 inconclusive");
assert.equal(c2.last?.result, "inconclusive");
assert.match(c2.last?.evidence ?? "", /slot=step:land.output.merged/, "证据槽摊平成人话");

// 判据原文是**对象**时同样认（接口上两种形态都出现过）
const objView = verificationView({
  status: "unverified",
  verification: {
    contract: [
      {
        idx: 1,
        name: "C1",
        criterion: { requirement: "R", evidence: { source: "s" }, expect: { exists: true } },
      },
    ],
    verdicts: [],
  },
});

// ---- 3) 其他形态 ----------------------------------------------------------------
const verdictsOnly = verificationView({
  verification: {
    contract: [],
    verdicts: [verdict(1, 1, "C1", "inconclusive", { reason: "nothing to compare" })],
  },
});
assert.match(verdictsOnly.headline, /没有钉住的完成契约/, "契约空但判过 → 说清是「没判据可对照」");
assert.equal(verdictsOnly.contract.length, 0);

const allPass = verificationView({
  verification: {
    contract: [{ idx: 1, name: "C1", criterion: "{bad json" }],
    verdicts: [verdict(1, 1, "C1", "pass")],
  },
});
assert.equal(allPass.tone, "pass", "最近一轮全过 → pass");
assert.match(allPass.headline, /判定全过/);
assert.equal(allPass.contract[0].requirement, "", "判据原文解不开就不编 requirement");
assert.equal(allPass.contract[0].slot, "");

const odd = verificationView({
  verification: { contract: [], verdicts: [verdict(1, 3, "C1", "weird")] },
});
assert.equal(odd.verdicts[0].tone, "other", "不认识的 result 照原文放着");
assert.equal(odd.verdicts[0].result, "weird");
assert.equal(odd.tone, "inconclusive", "没过（但既不是 fail 也不是 inconclusive）→ 按 inconclusive 显示");
assert.match(odd.headline, /C1 weird/);

// ---- 4) 渲染 -------------------------------------------------------------------
const markup = html(rich);
assert.ok(markup.includes('aria-label="验证"'), "验证是**自己**一节（section）");
assert.ok(markup.includes("验证（引擎判定）"));
assert.ok(markup.includes("auto-verify-contract"));
assert.ok(text(markup).includes("A report is produced"), "判据原文（requirement）在页面上");
assert.ok(text(markup).includes("证据槽 step:land.output.merged"), "证据槽在页面上");
assert.ok(text(markup).includes("期望 field=merged · equals=true"), "期望在页面上");
assert.ok(/auto-verify-badge is-inconclusive"[^>]*>inconclusive/.test(markup), "结果徽章带分级样式");
assert.ok(text(markup).includes("判定记录（4 次：pass 2 / fail 0 / inconclusive 2）"), "判定次数汇总");
assert.ok(text(markup).includes("问的 registry:git.merge"), "判定问的谁要显示");
assert.ok(text(markup).includes("期望 merged = true"), "期望 vs 实际：期望那一侧");
assert.ok(text(markup).includes("实际 merged = false"), "期望 vs 实际：实际那一侧");
assert.ok(text(markup).includes("no step named land ran"), "reason 原文在页面上");

const emptyMarkup = html({ status: "running", plans: [] });
assert.ok(text(emptyMarkup).includes("引擎还没判过这条任务"), "没判过就说没判过（不写「全过」）");

console.log("✅ verification section OK");

assert.equal(objView.contract[0].requirement, "R");
assert.equal(objView.contract[0].slot, "s");
assert.equal(objView.contract[0].expect, "exists=true");
assert.equal(objView.tone, "none");
assert.match(objView.headline, /契约在（1 条判据）/, "有契约没判定 → 说清「还没有哪一轮 done 被判定过」");

