export interface Project {
  projectId: string;
  name: string;
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

export interface RuntimeConfig {
  defaultProvider?: string;
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

export type AppView = "chat" | "global-settings" | "project-settings" | "usage-stats";

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
  /** GitHub pull request URL once opened for this task. */
  prUrl?: string;
  taskType: "general";
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

export type AgentSuccessionReason = "mode_change" | "session_unusable";

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
}

export interface AuthStatus {
  ok: boolean;
  detail: string;
  providers?: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface ProviderInfo {
  name: string;
  ok: boolean;
  detail: string;
  isDefault: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
}

export type UsageGranularity = "hour" | "day" | "week";

export interface UsageBucket {
  /** Local wall-clock start "YYYY-MM-DDTHH:mm:00" (no timezone suffix). */
  start: string;
  /** Short display label, e.g. "09-03", "09-03 14:00", "09-01周". */
  label: string;
  /** Full label for tooltip. */
  title: string;
}

/** One provider/model row aligned with `buckets`. */
export interface UsageStatsRow {
  provider: string;
  model?: string;
  /** Display label, e.g. `cline / claude-...`. */
  label: string;
  runCount: number;
  totalTokens: number;
  /** Per-bucket total tokens (index-aligned with `buckets`). */
  series: number[];
}

export interface TokenUsageSeries {
  granularity: UsageGranularity;
  /** Present when the series is filtered to a single project. */
  projectId?: string;
  /** First bucket start (local wall-clock). */
  from: string;
  /** One bucket past the last bucket (exclusive end, local wall-clock). */
  to: string;
  buckets: UsageBucket[];
  rows: UsageStatsRow[];
  /** Per-bucket total across all rows (index-aligned). */
  bucketTotalTokens: number[];
  totalTokens: number;
  runCount: number;
}
