import type { TaskType } from "../types.js";
import {
  CODING_WORKFLOW,
  CODING_WORKFLOW_STATES,
  CODING_WORKFLOW_TRANSITIONS,
  type CodingWorkflowState,
  allowedNextStates,
  canTransition,
  isCodingWorkflowState,
} from "./coding.js";

export type WorkflowState = CodingWorkflowState;

export interface TaskWorkflowView {
  name: string;
  states: WorkflowState[];
  currentState: WorkflowState;
  allowedNextStates: WorkflowState[];
}

export function getWorkflowForTaskType(taskType: TaskType): typeof CODING_WORKFLOW {
  switch (taskType) {
    case "general":
    default:
      return CODING_WORKFLOW;
  }
}

export function buildWorkflowView(
  taskType: TaskType,
  workflowState: string,
): TaskWorkflowView {
  const wf = getWorkflowForTaskType(taskType);
  const current = isCodingWorkflowState(workflowState)
    ? workflowState
    : "plan";
  return {
    name: wf.name,
    states: [...wf.states],
    currentState: current,
    allowedNextStates: allowedNextStates(current),
  };
}

export function validateTransition(
  taskType: TaskType,
  from: string,
  to: string,
): { ok: true; toState: WorkflowState } | { ok: false; error: string } {
  if (!isCodingWorkflowState(from)) {
    return { ok: false, error: `invalid current workflow state: ${from}` };
  }
  if (!isCodingWorkflowState(to)) {
    return { ok: false, error: `invalid target workflow state: ${to}` };
  }
  getWorkflowForTaskType(taskType);
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error: `cannot transition from ${from} to ${to}`,
    };
  }
  return { ok: true, toState: to };
}

export {
  CODING_WORKFLOW,
  CODING_WORKFLOW_STATES,
  CODING_WORKFLOW_TRANSITIONS,
  isCodingWorkflowState,
};
