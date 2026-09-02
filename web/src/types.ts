export interface Project {
  projectId: string;
  name: string;
  /** Per-project file root; new tasks use `<workspaceRoot>/<taskId>/`. */
  workspaceRoot?: string;
  /** Git remote/clone URL for this project. */
  gitRepoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRulesConfig {
  rules?: string;
}

export interface PlanExportConfig {
  exportDir?: string;
}

export interface AppSettings {
  agent?: AgentRulesConfig;
  plan?: PlanExportConfig;
}

export interface ProjectSettingsView {
  global: AppSettings;
  project: AppSettings;
  effective: AppSettings;
  cwdRules?: string;
}

export type AppView = "chat" | "global-settings" | "project-settings";

export interface Task {
  taskId: string;
  projectId: string;
  title: string;
  createdAt: string;
  status: "active" | "completed" | "error";
  workspace: string;
  provider: string;
  model?: string;
  agentId?: string;
  taskType: "general";
  workflowState: import("./workflows").WorkflowState;
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
  eventType: string;
  payload: Record<string, unknown>;
  usage?: TokenUsage;
  cost?: CostInfo;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  agentId: string;
  provider: string;
  model?: string;
  status: string;
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

export interface PlanDocumentSummary {
  runId: string;
  fileName?: string;
  path?: string;
  exportedAt: string;
  userText?: string;
  hasFile: boolean;
}

export interface PlanDocumentContent {
  runId: string;
  markdown: string;
  path?: string;
  fileName?: string;
  exportedAt: string;
  source: "file" | "synthesized";
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

export interface TaskDetail {
  task: Task;
  runs: RunRecord[];
  stats: TaskStats;
  workflow: import("./workflows").TaskWorkflowView;
}

export interface AuthStatus {
  ok: boolean;
  detail: string;
}
