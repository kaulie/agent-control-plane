import type { TaskWorkflowView, WorkflowState } from "../workflows";
import { WORKFLOW_STATE_LABELS } from "../workflows";

export default function WorkflowStepper({
  workflow,
  onTransition,
  transitioning,
  prUrl,
  canCreatePr,
  creatingPr,
  onCreatePr,
}: {
  workflow: TaskWorkflowView;
  onTransition?: (toState: WorkflowState) => void;
  transitioning?: boolean;
  prUrl?: string;
  canCreatePr?: boolean;
  creatingPr?: boolean;
  onCreatePr?: () => void;
}) {
  const currentIdx = workflow.states.indexOf(workflow.currentState);

  return (
    <div className="workflow-stepper" role="navigation" aria-label="Task workflow">
      <ol className="workflow-stepper-track">
        {workflow.states.map((state, idx) => {
          const done = idx < currentIdx;
          const active = state === workflow.currentState;
          const allowed = workflow.allowedNextStates.includes(state);
          const clickable = allowed && onTransition && !transitioning;

          return (
            <li
              key={state}
              className={`workflow-step${done ? " done" : ""}${active ? " active" : ""}${allowed && !active ? " next" : ""}`}
            >
              <button
                type="button"
                className="workflow-step-btn"
                disabled={!clickable}
                title={
                  clickable
                    ? `进入 ${WORKFLOW_STATE_LABELS[state]}`
                    : active
                      ? "当前阶段"
                      : undefined
                }
                onClick={() => clickable && onTransition?.(state)}
              >
                <span className="workflow-step-dot" aria-hidden />
                <span className="workflow-step-label">{WORKFLOW_STATE_LABELS[state]}</span>
              </button>
              {idx < workflow.states.length - 1 && (
                <span className="workflow-step-connector" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
      <div className="workflow-stepper-actions">
        {workflow.allowedNextStates.length > 0 &&
          onTransition &&
          workflow.currentState === "plan" &&
          workflow.allowedNextStates.includes("coding") && (
            <button
              type="button"
              className="workflow-primary-btn"
              disabled={transitioning}
              onClick={() => onTransition("coding")}
            >
              开始开发
            </button>
          )}
        {prUrl ? (
          <a
            className="workflow-pr-link"
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            title={prUrl}
          >
            查看 PR
          </a>
        ) : canCreatePr && onCreatePr ? (
          <button
            type="button"
            className="workflow-primary-btn"
            disabled={creatingPr || transitioning}
            onClick={() => onCreatePr()}
          >
            {creatingPr ? "创建 PR 中…" : "创建 PR"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
