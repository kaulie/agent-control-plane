/**
 * 主界面「四态条」的口径检查（执行方 = autonomy）：**规划中 / 执行中 / 阻塞 / 已完成**。
 *
 * 1. 四个词就是这四个（不跟着 autonomy 的 `running` / `unverified` 变）；
 * 2. 判定只依据接口真给的字段（任务状态 + 最新计划 + steps 状态 + error），并且**写清依据**；
 * 3. 两条硬口径：`pending` 的步骤**不写成「进行中」**（执行行是跑完才写的）；
 *    `unverified`（自称完成、引擎没验过）**算阻塞**，不算完成；
 * 4. 首帧（还没读到）不画，免得先闪一个错的态。
 *
 * 用法：npx tsx --tsconfig web/tsconfig.json web/scripts/test-executor-status.mjs
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: ExecutorPhaseBar } = await import("../src/components/ExecutorPhaseBar.tsx");
const { EXECUTOR_PHASE_LABEL, executorPhaseView } = await import("../src/autonomy.ts");

const phaseOf = (detail) => executorPhaseView(detail).phase;

// ---- 1) 四个词固定 ----
assert.deepEqual(EXECUTOR_PHASE_LABEL, {
  planning: "规划中",
  executing: "执行中",
  blocked: "阻塞",
  done: "已完成",
});

// ---- 2) 规划中：还没有「带步骤」的计划 ----
{
  const fresh = { task_id: "t", status: "running", plans: [] };
  const view = executorPhaseView(fresh);
  assert.equal(view.phase, "planning");
  assert.equal(view.label, "规划中");
  assert.match(view.hint, /还没给出这一轮的计划/);

  const accepted = { task_id: "t", status: "pending", plans: [] };
  assert.equal(phaseOf(accepted), "planning");
  assert.match(executorPhaseView(accepted).hint, /指令已受理/);

  // 最新一轮只是「决定」（没有 steps），且历史上从没有过带步骤的计划 → 仍在规划
  const decisionOnly = {
    task_id: "t",
    status: "running",
    plans: [{ plan_id: 1, cycle: 1, decision_type: "done", reason: "已经在做了" }],
  };
  assert.equal(phaseOf(decisionOnly), "planning");
}


// ---- 3) 执行中：已有带步骤的计划在推进 ----
{
  const running = {
    task_id: "t",
    status: "running",
    plans: [
      {
        plan_id: 1,
        cycle: 1,
        decision_type: "plan",
        step_count: 3,
        executed: 2,
        steps: [
          { idx: 1, name: "edit", capability: "code_edit", status: "ok" },
          { idx: 2, name: "report", capability: "code_edit", status: "ok" },
          { idx: 3, name: "review", capability: "pull_request.review", status: "pending" },
        ],
      },
    ],
  };
  const view = executorPhaseView(running);
  assert.equal(view.phase, "executing");
  assert.equal(view.label, "执行中");
  assert.match(view.hint, /最新计划 3 步：2 步已完成/);
  // pending ≠ 进行中：口径写「还没执行」，并给出这一步是谁
  assert.match(view.hint, /第 3 步 review（pull_request.review）还没执行/);
  assert.ok(!view.hint.includes("进行中"), "pending 不写成「进行中」");

  // 上一轮计划执行完、最新一轮是「决定」→ 仍在执行（它马上给下一步）
  const decided = {
    ...running,
    plans: [
      // 上一轮 3 步都跑完了，最新一轮只是「决定」
      {
        ...running.plans[0],
        steps: running.plans[0].steps.map((s) => ({ ...s, status: "ok" })),
      },
      { plan_id: 2, cycle: 2, decision_type: "done", reason: "合约满足" },
    ],
  };
  const view2 = executorPhaseView(decided);
  assert.equal(view2.phase, "executing");
  assert.match(view2.hint, /上一轮计划 3 步：3 步已执行完，执行方正在给出下一步/);
}

// ---- 4) 阻塞：停了 / 等输入 / 自称完成没验过 / 报错 ----
{
  const stopped = { task_id: "t", status: "stopped", plans: [] };
  assert.equal(phaseOf(stopped), "blocked");
  assert.match(executorPhaseView(stopped).hint, /执行方状态 stopped/);

  // `need` 是接口上的 JSON 字符串（真实形态）→ 优先显示「它在等什么」，比 reason 具体
  const needInput = {
    task_id: "t",
    status: "running",
    plans: [
      {
        plan_id: 1,
        cycle: 1,
        decision_type: "need_input",
        reason: "Cycle 1 executed the planned steps…",
        need: JSON.stringify({
          type: "approval",
          description: "等人 review 并合入 PR #117",
        }),
      },
    ],
  };
  const view = executorPhaseView(needInput);
  assert.equal(view.phase, "blocked");
  assert.equal(view.label, "阻塞");
  assert.match(view.hint, /等外部 \/ 等输入（need_input）/);
  assert.match(view.hint, /等人 review 并合入 PR #117/);

  // 退路：need 拿不到 / 不是 JSON → 用 reason；need 是对象 → 直接读 description
  const needObj = {
    task_id: "t",
    status: "running",
    plans: [
      { plan_id: 1, cycle: 1, decision_type: "blocked", reason: "r", need: { description: "等一次人工放行" } },
    ],
  };
  assert.match(executorPhaseView(needObj).hint, /等一次人工放行/);
  const needFallback = {
    task_id: "t",
    status: "running",
    plans: [{ plan_id: 1, cycle: 1, decision_type: "need_input", reason: "要先确认用哪个仓库" }],
  };
  assert.match(executorPhaseView(needFallback).hint, /要先确认用哪个仓库/);

  // 真实形态：**状态本身就是 need_input**，而「在等什么」在 need 里（比 reason 具体）
  const waitingStatus = {
    task_id: "t",
    status: "need_input",
    plans: [
      {
        plan_id: 1,
        cycle: 1,
        decision_type: "need_input",
        reason: "Cycle 1 executed the planned steps…",
        need: JSON.stringify({
          type: "approval",
          description: "A human must review, approve and merge the open pull request(s)",
        }),
      },
    ],
  };
  const waitingView = executorPhaseView(waitingStatus);
  assert.equal(waitingView.phase, "blocked");
  assert.match(waitingView.hint, /执行方状态 need_input：A human must review, approve and merge/);
  assert.ok(!waitingView.hint.includes("Cycle 1 executed"), "need 有时不要退化成 reason");

  // unverified：自称完成、引擎没验过 → 阻塞，不能当完成
  const unverified = {
    task_id: "t",
    status: "unverified",
    plans: [{ plan_id: 4, cycle: 4, decision_type: "done", reason: "报告已产出" }],
  };
  const view2 = executorPhaseView(unverified);
  assert.equal(view2.phase, "blocked");
  assert.match(view2.hint, /自称已完成，但引擎验证没通过/);
  assert.match(view2.hint, /需要重试或人工确认/);

  const errored = { task_id: "t", status: "error", error: "world_model:asset 不存在", plans: [] };
  const view3 = executorPhaseView(errored);
  assert.equal(view3.phase, "blocked");
  assert.match(view3.hint, /world_model:asset 不存在/);
}

// ---- 5) 已完成：它说这条 task 结束了 ----
{
  const completed = {
    task_id: "t",
    status: "completed",
    plans: [{ plan_id: 9, cycle: 9, decision_type: "done", reason: "PR #113 已合入" }],
  };
  const view = executorPhaseView(completed);

// ---- 6) 真实那次「自部署打断」的形态（task-2c438baf5499b592 的 plan 14） ----
{
  const real = {
    task_id: "t",
    status: "running",
    plans: [
      {
        plan_id: 14,
        cycle: 4,
        decision_type: "plan",
        step_count: 2,
        executed: 1,
        steps: [
          { idx: 1, name: "deploy", capability: "service.deploy", status: "ok" },
          { idx: 2, name: "monitor", capability: "deployment.monitor", status: "pending" },
        ],
      },
    ],
  };
  const view = executorPhaseView(real);
  assert.equal(view.phase, "executing");
  assert.match(view.hint, /1 步已完成/);
  assert.match(view.hint, /第 2 步 monitor（deployment.monitor）还没执行/);
  assert.match(view.hint, /可能在跑，也可能上次运行被中断/);
}

// ---- 7) 渲染：角标文字 + 配色类 + 原始状态进悬停；首帧不画 ----
{
  const html = renderToStaticMarkup(
    React.createElement(ExecutorPhaseBar, { detail: { task_id: "t", status: "unverified", plans: [] } }),
  );
  assert.ok(html.includes("exec-phase is-blocked"), "阻塞用 is-blocked");
  assert.ok(html.includes('data-phase="blocked"'));
  assert.ok(html.includes(">阻塞<"), "角标就是「阻塞」两个字");
  assert.ok(html.includes("执行方原始状态：unverified"), "原始状态照实放悬停，不隐藏");
  assert.ok(html.includes('role="status"'), "状态变化要能被读屏播报");

  const executing = renderToStaticMarkup(
    React.createElement(ExecutorPhaseBar, {
      detail: {
        task_id: "t",
        status: "running",
        plans: [
          {
            plan_id: 1,
            cycle: 1,
            decision_type: "plan",
            steps: [{ idx: 1, name: "edit", capability: "code_edit", status: "ok" }],
          },
        ],
      },
    }),
  );
  assert.ok(executing.includes("exec-phase is-executing"));
  assert.ok(executing.includes(">执行中<"));

  const done = renderToStaticMarkup(
    React.createElement(ExecutorPhaseBar, { detail: { task_id: "t", status: "completed", plans: [] } }),
  );
  assert.ok(done.includes("exec-phase is-done"));
  assert.ok(done.includes(">已完成<"));

  const planning = renderToStaticMarkup(
    React.createElement(ExecutorPhaseBar, { detail: { task_id: "t", status: "running", plans: [] } }),
  );
  assert.ok(planning.includes("exec-phase is-planning"));
  assert.ok(planning.includes(">规划中<"));

  // 首帧（loaded=false）→ 什么都不画，避免先闪一个错态
  const first = renderToStaticMarkup(
    React.createElement(ExecutorPhaseBar, { detail: null, loaded: false }),
  );
  assert.equal(first, "");
}

console.log(
  "PASS: 主界面四态（规划中 / 执行中 / 阻塞 / 已完成 —— 依据写清、pending 不谎称进行中、unverified 不算完成、首帧不闪）",
);

  assert.equal(view.phase, "done");
  assert.equal(view.label, "已完成");
  assert.match(view.hint, /执行方状态 completed：PR #113 已合入/);
}
