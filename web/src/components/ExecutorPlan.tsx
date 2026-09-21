import {
  currentStep,
  latestPlan,
  latestSteppedPlan,
  planPhase,
  planViews,
  statusClass,
  stepLabel,
  stepProgress,
  type PlanStepView,
  type PlanView,
  type StepPhase,
} from "../autonomy";
import { formatDuration, truncate } from "../format";
import type { AutonomyTaskDetail } from "../types";

/**
 * 执行方（autonomy）的**计划区** —— 主界面在最显眼的位置回答三个问题：
 *
 * 1. 还没形成 plan → **正在规划…**；
 * 2. 拿到 plan → 显示**最新**那一轮计划（`plan_id` / `cycle` / 决定）；
 * 3. 同时给出**已完成的 step**（`已完成 x/y`）和**当前 step 的进展**（状态 / 耗时 / 产出 / 错误）。
 *
 * 只画接口真给的东西：运行中 step 的「局部进展」autonomy 还没有 → 不编百分比、不写占位；
 * 已结束且从没给过 plan → 照实说「没有计划」，不谎称还在规划。
 *
 * 纯展示件（不自己取数）：拿 `detail` + 任务状态，SSR 可直接测。
 */
const ICON: Record<StepPhase, string> = {
  done: "✓",
  running: "▶",
  failed: "✗",
  pending: "○",
};

function StepRow({ step, current }: { step: PlanStepView; current: boolean }) {
  const metas = [step.status, step.durationMs != null ? formatDuration(step.durationMs) : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      className={`auto-plan-step ${step.phase}${current ? " is-current" : ""}`}
      {...(step.expectedEffect ? { title: `预期：${step.expectedEffect}` } : {})}
    >
      <span className="auto-plan-icon" aria-hidden="true">
        {ICON[step.phase]}
      </span>
      <span className="auto-plan-step-main">
        <span className="auto-plan-step-head">
          <span className="auto-plan-step-idx">{step.idx}.</span>
          <span className="auto-plan-step-name">{step.name || step.capability}</span>
          {step.name && step.capability ? (
            <span className="auto-plan-cap">{step.capability}</span>
          ) : null}
          {current ? <span className="auto-plan-current">当前</span> : null}
          <span className={`auto-status ${statusClass(step.status)}`}>{metas}</span>
        </span>
        {step.error ? <span className="auto-plan-note bad">{step.error}</span> : null}
        {step.outputSummary ? (
          <span className="auto-plan-note" title={step.outputSummary}>
            {truncate(step.outputSummary.replace(/\s+/g, " "), 200)}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function PlanHead({ plan, label }: { plan: PlanView; label: string }) {
  const { done, failed, total } = stepProgress(plan);
  return (
    <div className="auto-plan-head">
      <span className="auto-plan-title">{label}</span>
      {plan.planId != null ? (
        <span className="task-id-chip is-static" title="执行方那侧的 plan id">
          <span className="task-id-label">计划</span>
          <code className="task-id-value">#{plan.planId}</code>
        </span>
      ) : null}
      {plan.cycle != null ? (
        <span className="task-id-chip is-static" title="第几轮（一个 cycle 一条 plan）">
          <span className="task-id-label">cycle</span>
          <code className="task-id-value">{plan.cycle}</code>
        </span>
      ) : null}
      {plan.decisionType && plan.decisionType !== "plan" ? (
        <span className={`auto-status ${statusClass(plan.decisionType)}`} title="这一轮执行方的决定">
          决定：{plan.decisionType}
        </span>
      ) : null}
      {total > 0 ? (
        <span className="auto-plan-count">
          已完成 {done}/{total}
          {failed > 0 ? ` · 失败 ${failed}` : ""}
        </span>
      ) : null}
    </div>
  );
}

interface Props {
  detail: AutonomyTaskDetail | null;
  /** 任务状态（执行方那边；读不到时用列表行里的）。 */
  status: string;
}

export default function PlanSection({ detail, status }: Props) {
  const plans = planViews(detail);
  const phase = planPhase({ loaded: detail != null, plans, status });

  // 首帧（还没读到）：不显示、也不闪「正在规划」。
  if (phase === "loading") return null;

  if (phase === "planning") {
    return (
      <section className="auto-plan is-planning" aria-label="计划">
        <span className="auto-plan-title">正在规划…</span>
        <span className="auto-plan-hint">执行方还没给出这一轮的计划（拿到就显示在这里）</span>
      </section>
    );
  }

  if (phase === "none") {
    return (
      <section className="auto-plan is-none" aria-label="计划">
        <span className="auto-plan-title">没有计划</span>
        <span className="auto-plan-hint">
          执行方从没给出 plan{status ? `（任务已结束：${status}）` : ""}
        </span>
      </section>
    );
  }

  const latest = latestPlan(detail);
  if (!latest) return null;
  const latestHasSteps = latest.steps.length > 0;
  // 最新那条常常是「决定」（收尾说明）：这时步骤取上一轮**带步骤**的计划。
  const stepped = latestHasSteps ? latest : latestSteppedPlan(detail);
  const current = latestHasSteps ? currentStep(latest) : undefined;

  return (
    <section className="auto-plan" aria-label="计划">
      {latestHasSteps ? (
        <PlanHead plan={latest} label="最新计划" />
      ) : (
        <>
          <PlanHead plan={latest} label="最新决定" />
          {latest.reason ? (
            // 决定原因常常是一整段（模型写的）：短就平铺，长就折起来（和「原始响应」同一个套路）。
            latest.reason.length > 300 ? (
              <details className="auto-plan-reason">
                <summary>{truncate(latest.reason.replace(/\s+/g, " "), 300)}</summary>
                {latest.reason}
              </details>
            ) : (
              <div className="auto-plan-reason">{latest.reason}</div>
            )
          ) : null}
        </>
      )}

      {!latestHasSteps && stepped ? <PlanHead plan={stepped} label="上一轮计划" /> : null}

      {stepped && stepped.steps.length > 0 ? (
        <ol className="auto-plan-steps">
          {stepped.steps.map((step) => (
            <StepRow
              key={step.key}
              step={step}
              current={latestHasSteps && step.key === current?.key}
            />
          ))}
        </ol>
      ) : null}

      {latestHasSteps && current ? (
        <div className="auto-plan-currentline">
          当前 step：{stepLabel(current)} · 状态 {current.status}
          {current.durationMs != null ? ` · 已耗时 ${formatDuration(current.durationMs)}` : ""}
          {current.expectedEffect ? ` · 预期 ${current.expectedEffect}` : ""}
        </div>
      ) : null}

      {plans.length > 1 ? (
        <details className="auto-plan-history">
          <summary>往期计划（{plans.length} 轮）</summary>
          <ul>
            {plans
              .slice(0, -1)
              .reverse()
              .map((p) => {
                const { done, total } = stepProgress(p);
                return (
                  <li key={p.key}>
                    #{p.planId ?? "?"} · cycle {p.cycle ?? "?"}
                    {p.decisionType ? ` · ${p.decisionType}` : ""}
                    {total > 0 ? ` · 已完成 ${done}/${total}` : ""}
                  </li>
                );
              })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
