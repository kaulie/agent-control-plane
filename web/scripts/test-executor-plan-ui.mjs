/**
 * 主界面「计划区」的口径检查（执行方 = autonomy）：
 *
 * 1. **还没形成 plan** → 显示「正在规划…」（不谎称、不占位）；
 * 2. **拿到 plan** → 显示**最新**那一轮（`plan_id` / `cycle` / 决定）；
 * 3. 同时显示**已完成的 step** 与**当前 step 的进展**（状态 / 耗时 / 产出 / 错误）；
 * 4. 拿不到的（运行中 step 的局部进展）**不编**；已结束且从没给过 plan → 照实说「没有计划」。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-executor-plan-ui.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: PlanSection } = await import("../src/components/ExecutorPlan.tsx");
const {
  currentStep,
  latestPlan,
  latestSteppedPlan,
  planPhase,
  planViews,
  stepLabel,
  stepPhase,
  stepProgress,
} = await import("../src/autonomy.ts");

const render = (props) => renderToStaticMarkup(React.createElement(PlanSection, props));

// 真实接口的形状（照 task-2c438baf5499b592 的记录）：plan_id / cycle / decision_type / steps[].idx|name|capability|status|duration_ms|output|error
const runningDetail = {
  task_id: "task-exec-1",
  status: "running",
  updated_at: "2026-09-21T02:00:00Z",
  plans: [
    {
      plan_id: 1,
      cycle: 1,
      decision_type: "plan",
      step_count: 3,
      executed: 3,
      steps: [
        {
          idx: 1,
          name: "report",
          capability: "code_edit",
          status: "ok",
          duration_ms: 44322,
          expected_effect: '{"creates":"TASK_CONTEXT_REPORT.md"}',
          output: { summary: "Created the report.\n\n## What I did", pr_url: "https://github.com/kaulie/agent-control-plane/pull/108" },
        },
        {
          idx: 2,
          name: "land",
          capability: "pull_request.review",
          status: "running",
          planned_input: { method: "merge" },
          expected_effect: '{"merges":"PR #110 into main"}',
        },
        { idx: 3, name: "verify", capability: "checks", status: "pending" },
      ],
    },
    {
      plan_id: 2,
      cycle: 2,
      decision_type: "plan",
      step_count: 1,
      executed: 1,
      steps: [
        {
          idx: 1,
          name: "land",
          capability: "pull_request.review",
          status: "failed",
          duration_ms: 1352,
          error: "checks_pending: ci (in_progress) on 5be75e76 — ask again once they finish",
        },
      ],
    },
  ],
};

// ---- 1) 纯函数：解析 / 阶段 / 统计 ----
{
  assert.equal(stepPhase("ok"), "done");
  assert.equal(stepPhase("succeeded"), "done");
  assert.equal(stepPhase("running"), "running");
  assert.equal(stepPhase("in_progress"), "running");
  assert.equal(stepPhase("failed"), "failed");
  assert.equal(stepPhase("pending"), "pending");
  assert.equal(stepPhase("什么鬼"), "pending", "未知状态不猜成已完成");

  const plans = planViews(runningDetail);
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((p) => p.planId),
    [1, 2],
    "按 plan_id 升序（接口给的是升序，这里再兜一次）"
  );
  assert.equal(latestPlan(runningDetail).planId, 2, "最新一轮");
  assert.equal(
    latestSteppedPlan(runningDetail).planId,
    2,
    "最新一轮带步骤的就是它"
  );
  const first = plans[0];
  assert.equal(first.cycle, 1);
  assert.equal(first.decisionType, "plan");
  assert.equal(first.steps.length, 3);
  assert.equal(first.steps[0].status, "ok");
  assert.equal(first.steps[0].phase, "done");
  assert.equal(first.steps[0].durationMs, 44322, "耗时保留原始毫秒（格式化交给 formatDuration）");
  assert.match(first.steps[0].outputSummary, /Created the report/, "产出优先取 output.summary");
  assert.equal(first.steps[0].expectedEffect, "creates=TASK_CONTEXT_REPORT.md", "expected_effect 摊成 k=v");
  assert.equal(first.steps[1].phase, "running");
  assert.equal(first.steps[1].outputSummary, undefined, "没产出就不给这个字段（不写占位）");
  assert.deepEqual(stepProgress(first), { done: 1, failed: 0, total: 3 }, "已完成 x/y");
  assert.equal(stepLabel(currentStep(first)), "land（pull_request.review）", "当前 step = 正在跑的那步");
  const second = plans[1];
  assert.deepEqual(stepProgress(second), { done: 0, failed: 1, total: 1 });
  assert.equal(currentStep(second).status, "failed", "没有在跑的 → 失败的算当前（要求人处理）");

  // 决定型 plan（收尾说明，没有 steps）
  const decided = {
    status: "unverified",
    plans: [
      ...runningDetail.plans,
      { plan_id: 4, cycle: 4, decision_type: "done", reason: "Contract C1 satisfied by the report.", step_count: 0, executed: 0, steps: [] },
    ],
  };
  assert.equal(latestPlan(decided).decisionType, "done");
  assert.equal(latestPlan(decided).reason, "Contract C1 satisfied by the report.");
  assert.equal(
    latestSteppedPlan(decided).planId,
    2,
    "最新那条是决定 → 步骤取上一轮带步骤的"
  );

  // 阶段判定
  assert.equal(planPhase({ loaded: false, plans: [], status: "running" }), "loading", "首帧不闪「正在规划」");
  assert.equal(planPhase({ loaded: true, plans: [], status: "running" }), "planning");
  assert.equal(planPhase({ loaded: true, plans: [], status: "pending" }), "planning");
  assert.equal(planPhase({ loaded: true, plans: [], status: "stopped" }), "none", "已结束且没 plan → 照实说");
  assert.equal(planPhase({ loaded: true, plans: [], status: "unverified" }), "none");
  assert.equal(planPhase({ loaded: true, plans: plans, status: "running" }), "planned");
}

// ---- 2) 还没形成 plan：显示「正在规划…」 ----
{
  const html = render({ detail: { task_id: "t", status: "running", plans: [] }, status: "running" });
  assert.ok(html.includes("正在规划"), "正在规划");
  assert.ok(html.includes("执行方还没给出这一轮的计划"), "说清是等执行方的 plan");
  assert.ok(!html.includes("最新计划"), "没有 plan 就不画计划头");
  assert.ok(!html.includes("已完成"), "没步骤就别写计数（不占位）");
}

// ---- 3) 首帧（还没读到）：什么都不画 ----
{
  assert.equal(render({ detail: null, status: "running" }), "", "读之前不显示、也不闪「正在规划」");
  assert.equal(render({ detail: null, status: "stopped" }), "");
}

// ---- 4) 已结束且从没给过 plan：照实说「没有计划」 ----
{
  const html = render({ detail: { task_id: "t", status: "stopped", plans: [] }, status: "stopped" });
  assert.ok(html.includes("没有计划"));
  assert.ok(html.includes("stopped"), "带上任务状态，别让人以为还在跑");
  assert.ok(!html.includes("正在规划"), "不谎称还在规划");
}

// ---- 5) 有 plan：最新计划 + 已完成 step + 当前 step 进展 ----
{
  const html = render({ detail: runningDetail, status: "running" });
  assert.ok(html.includes("最新计划"), "最新计划");
  assert.ok(!html.includes("最新决定"), "最新那条是执行计划，不是决定");
  assert.ok(html.includes("#2"), "plan_id");
  assert.ok(html.includes("cycle"), "cycle");
  assert.ok(html.includes("已完成 0/1"), "已完成 step 计数（这一轮）");
  assert.ok(html.includes("失败 1"), "失败的也要写清");
  // 步骤明细：名字 / capability / 状态 / 耗时 / 产出 / 错误
  assert.ok(html.includes("auto-plan-step"), "步骤是列表，不是 chips");
  assert.ok(html.includes("land"), "step name");
  assert.ok(html.includes("pull_request.review"), "capability");
  assert.ok(html.includes("failed"), "原始状态文本照旧显示");
  assert.ok(html.includes("1秒"), "耗时复用 formatDuration（1352ms → 1秒）");
  assert.ok(html.includes("checks_pending"), "失败原文（要求人处理）");
  assert.ok(html.includes("往期计划（2 轮）"), "往期计划折叠可查");
  // 决定型最新 plan（done）时：显示最新决定 + 上一轮计划
  const decidedHtml = render({
    detail: {
      ...runningDetail,
      plans: [
        ...runningDetail.plans,
        { plan_id: 4, cycle: 4, decision_type: "done", reason: "Contract C1 satisfied.", step_count: 0, executed: 0, steps: [] },
      ],
    },
    status: "running",
  });
  assert.ok(decidedHtml.includes("最新决定"), "最新那条是决定");
  assert.ok(decidedHtml.includes("决定：done"), "决定的类型");
  assert.ok(decidedHtml.includes("Contract C1 satisfied."), "决定的原因");
  assert.ok(decidedHtml.includes("上一轮计划"), "步骤回落到上一轮计划");
  assert.ok(decidedHtml.includes("已完成 0/1"), "上一轮的计数照旧");
  assert.ok(!decidedHtml.includes('<details class="auto-plan-reason"'), "短原因平铺");

  // 长原因（模型写的一整段）折起来，但全文仍在（可展开）
  const longReason = "x".repeat(400) + "END";
  const longHtml = render({
    detail: {
      status: "unverified",
      plans: [{ plan_id: 1, cycle: 1, decision_type: "done", reason: longReason, step_count: 0, executed: 0, steps: [] }],
    },
    status: "unverified",
  });
  assert.ok(longHtml.includes('<details class="auto-plan-reason"'), "长原因可展开");
  assert.ok(longHtml.includes("END"), "全文不丢");
}

// ---- 6) 全部完成的 plan：没有「当前 step」，不编进展 ----
{
  const doneDetail = {
    status: "running",
    plans: [
      {
        plan_id: 1,
        cycle: 1,
        decision_type: "plan",
        step_count: 2,
        executed: 2,
        steps: [
          { idx: 1, name: "write", capability: "code_edit", status: "ok", duration_ms: 44322, output: { summary: "done" } },
          { idx: 2, name: "push", capability: "git", status: "succeeded", duration_ms: 61234 },
        ],
      },
    ],
  };
  const html = render({ detail: doneDetail, status: "running" });
  assert.ok(html.includes("已完成 2/2"));
  assert.ok(!html.includes("当前 step"), "没有在跑/待跑的 step → 不写「当前」");
  assert.ok(!html.includes("is-current"), "没有当前高亮");
  assert.ok(html.includes("44秒") && html.includes("1分钟1秒"), "每步耗时");
}

// ---- 7) 运行中的 step 只有 status：不编百分比/假进展 ----
{
  const html = render({
    detail: {
      status: "running",
      plans: [
        {
          plan_id: 1,
          cycle: 1,
          decision_type: "plan",
          step_count: 1,
          executed: 0,
          steps: [{ idx: 1, name: "write", capability: "code_edit", status: "running" }],
        },
      ],
    },
    status: "running",
  });
  assert.ok(html.includes("is-current"), "当前 step 高亮");
  assert.ok(html.includes("当前 step：write（code_edit）"), "当前 step 是哪一步");
  assert.ok(!/%/.test(html), "没有编百分比");
  assert.ok(!html.includes("已耗时"), "没有耗时就不写（它没给开始时间）");
}

console.log(
  "PASS: 计划区（正在规划 / 最新计划 + 已完成 step + 当前 step 进展 / 决定型 plan / 拿不到就不显示）"
);
