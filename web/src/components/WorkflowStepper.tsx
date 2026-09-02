import type { TaskWorkflowView, WorkflowState } from "../workflows";
import { WORKFLOW_STATE_LABELS } from "../workflows";

export default function WorkflowStepper({
  workflow,
  onTransition,
  transitioning,
}: {
  workflow: TaskWorkflowView;
  onTransition?: (toState: WorkflowState) => void;
  transitioning?: boolean;
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
      {workflow.allowedNextStates.length > 0 && onTransition && (
        <div className="workflow-stepper-actions">
          {workflow.currentState === "plan" &&
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
        </div>
      )}
    </div>
  );
}
