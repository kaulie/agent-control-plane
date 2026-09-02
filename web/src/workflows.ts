export type WorkflowState =
  | "plan"
  | "coding"
  | "pr"
  | "ci"
  | "test"
  | "deploy"
  | "done";

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  plan: "规划",
  coding: "开发",
  pr: "PR",
  ci: "CI",
  test: "测试",
  deploy: "部署",
  done: "完成",
};

export const WORKFLOW_STATES: WorkflowState[] = [
  "plan",
  "coding",
  "pr",
  "ci",
  "test",
  "deploy",
  "done",
];

export interface TaskWorkflowView {
  name: string;
  states: WorkflowState[];
  currentState: WorkflowState;
  allowedNextStates: WorkflowState[];
}
