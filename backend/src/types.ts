export type TaskStatus = "active" | "completed" | "error";

export type TaskType = "general";

export type WorkflowState =
  | "plan"
  | "coding"
  | "pr"
  | "ci"
  | "test"
  | "deploy"
  | "done";

export interface AgentRulesConfig {
  rules?: string;
}

export interface PlanExportConfig {
  /** Absolute directory; empty/omit = disabled at this level. */
  exportDir?: string;
}

/** Per-project (or global) defaults for which agent runtime to use. */
export interface RuntimeConfig {
  /** Provider name (`cursor` | `cline`). Empty = fall back to AGENT_PROVIDER. */
  defaultProvider?: string;
  /** Optional default model id for the chosen provider. */
  defaultModel?: string;
}

export interface AppSettings {
  agent?: AgentRulesConfig;
  plan?: PlanExportConfig;
  runtime?: RuntimeConfig;
}

export interface ProjectSettingsView {
  global: AppSettings;
  project: AppSettings;
  effective: AppSettings;
  cwdRules?: string;
}

export interface Project {
  projectId: string;
  name: string;
  /** Per-project agent sandbox root; new tasks use `<workspaceRoot>/<taskId>/`. */
  workspaceRoot?: string;
  /** Git remote/clone URL for this project (https, ssh, or local path). */
  gitRepoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  userId: string;
  name: string;
  isSystem: boolean;
  createdAt: string;
}

export interface Task {
  taskId: string;
  projectId: string;
  title: string;
  createdAt: string;
  status: TaskStatus;
  workspace: string;
  provider: string;
  model?: string;
  createdBy?: string;
  /** Current bound SDK agent for this task. Replaced on succession; history is in agent_successions. */
  agentId?: string;
  /** GitHub pull request URL once opened for this task. */
  prUrl?: string;
  /** Task category; phase 1 only supports general. */
  taskType: TaskType;
  /** Current step in the task workflow state machine. */
  workflowState: WorkflowState;
}

export type RunStatus = "queued" | "running" | "finished" | "error" | "cancelled";

export interface RunRecord {
  runId: string;
  taskId: string;
  agentId: string;
  provider: string;
  model?: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  result?: string;
  error?: string;
  usage?: TokenUsage;
  cost?: CostInfo;
  modelCalls: number;
  toolCalls: number;
}

export type EventType =
  | "user_message"
  | "run_started"
  | "status"
  | "thinking"
  | "agent_response"
  | "tool_call_started"
  | "tool_result"
  | "file_read"
  | "file_edit"
  | "terminal"
  | "search"
  | "usage"
  | "run_completed"
  | "run_cancelled"
  | "run_error"
  | "plan_exported"
  | "plan_question_batch"
  | "plan_draft"
  | "agent_decision"
  | "agent_succession";

/** Why a task's bound agent id was replaced by a successor. */
export type AgentSuccessionReason = "mode_change" | "session_unusable";

/**
 * Explicit lineage when a task gets a new SDK agent/session while inheriting
 * prior conversation context (e.g. Cline plan→yolo rebuild).
 */
export interface AgentSuccession {
  successionId: string;
  taskId: string;
  runId: string;
  provider: string;
  fromAgentId: string;
  toAgentId: string;
  reason: AgentSuccessionReason;
  fromMode: string;
  toMode: string;
  seededMessages: number;
  createdAt: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CostInfo {
  rawCostCents?: number;
  chargedCents?: number;
  estimatedCents?: number;
  currency: string;
  model?: string;
}

export interface AgentEvent {
  eventId: string;
  seq?: number;
  taskId: string;
  runId: string;
  agentId: string;
  timestamp: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  usage?: TokenUsage;
  cost?: CostInfo;
}

export interface TaskStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costCents?: number;
  estimatedCents?: number;
  currency: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  runCount: number;
}
