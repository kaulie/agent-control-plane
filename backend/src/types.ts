export type TaskStatus = "active" | "completed" | "error";

export interface AgentRulesConfig {
  rules?: string;
}

export interface AppSettings {
  agent?: AgentRulesConfig;
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
  /** Bound SDK agent for this task (1 task = 1 agent). Set on first message. */
  agentId?: string;
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
  | "run_error";

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
