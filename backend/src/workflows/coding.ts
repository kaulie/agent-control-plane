export type CodingWorkflowState =
  | "plan"
  | "coding"
  | "pr"
  | "ci"
  | "test"
  | "deploy"
  | "done";

export const CODING_WORKFLOW_STATES: CodingWorkflowState[] = [
  "plan",
  "coding",
  "pr",
  "ci",
  "test",
  "deploy",
  "done",
];

export const CODING_WORKFLOW_TRANSITIONS: Record<
  CodingWorkflowState,
  CodingWorkflowState[]
> = {
  plan: ["coding"],
  coding: ["pr", "plan"],
  pr: ["ci"],
  ci: ["test", "coding"],
  test: ["deploy", "coding", "plan"],
  deploy: ["done"],
  done: [],
};

export const CODING_WORKFLOW = {
  name: "coding",
  states: CODING_WORKFLOW_STATES,
  transitions: CODING_WORKFLOW_TRANSITIONS,
} as const;

export function isCodingWorkflowState(v: string): v is CodingWorkflowState {
  return (CODING_WORKFLOW_STATES as readonly string[]).includes(v);
}

export function allowedNextStates(
  current: CodingWorkflowState,
): CodingWorkflowState[] {
  return CODING_WORKFLOW_TRANSITIONS[current] ?? [];
}

export function canTransition(
  from: CodingWorkflowState,
  to: CodingWorkflowState,
): boolean {
  return allowedNextStates(from).includes(to);
}
