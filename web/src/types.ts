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

/** System-wide agent sandbox root; cwd = `<root>/<project-name>/<taskId>/`. */
export interface WorkspaceConfig {
  /** Absolute path; empty/omit = default `/Users/gaolei/agent-workspace`. */
  root?: string;
}

export interface DeploymentServiceConfig {
  serviceId: string;
  gracefulRestart?: boolean;
  restartNotifyUrl?: string;
  restartPollUrl?: string;
}

export interface DeploymentConfig {
  services?: DeploymentServiceConfig[];
  /** @deprecated migrated into services[0] */
  gracefulRestart?: boolean;
  /** @deprecated migrated into services[0] */
  restartNotifyUrl?: string;
  /** @deprecated migrated into services[0] */
  restartPollUrl?: string;
}

export interface AppSettings {
  agent?: AgentRulesConfig;
  plan?: PlanExportConfig;
  runtime?: RuntimeConfig;
  workspace?: WorkspaceConfig;
  deployment?: DeploymentConfig;
}

export interface ProjectSettingsView {
  global: AppSettings;
  project: AppSettings;
  effective: AppSettings;
  cwdRules?: string;
}

export type AppView =
  | "chat"
  | "global-settings"
  | "project-settings"
  | "usage-stats"
  | "agent-runtime";

export interface ConcurrencySample {
  t: string;
  runningCount: number;
}

export type ConcurrencyGranularity = "raw" | "minute" | "hour";

export interface AgentRuntimeStatus {
  runningCount: number;
  maxConcurrentRuns: number;
  queuedCount: number;
  activeRuns: Array<{
    taskId: string;
    runId: string;
    projectId?: string;
    projectName?: string;
    taskTitle?: string;
    /** ISO time when this run began occupying a concurrency slot. */
    occupiedAt?: string;
  }>;
  queuedRuns?: Array<{
    taskId: string;
    runId: string;
    projectId?: string;
    projectName?: string;
    taskTitle?: string;
    mode?: "agent" | "plan";
  }>;
  series: ConcurrencySample[];
  sampleIntervalMs: number;
  windowMs?: number;
  from?: string;
  to?: string;
  granularity?: ConcurrencyGranularity;
  admissionPaused?: boolean;
  admissionPausedAt?: string;
}

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
  /** ISO time of the latest user message; drives sidebar sort. */
  lastUserInputAt?: string;
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

/** Calendar used when flooring runs into hour/day/week buckets. */
export type UsageTimeZone = "local" | "utc";

export interface UsageBucket {
  /**
   * Wall-clock start "YYYY-MM-DDTHH:mm:00" in the series `timeZone`
   * (no offset suffix).
   */
  start: string;
  /** Short display label, e.g. "09-03", "09-03 14:00", "09-01周". */
  label: string;
  /** Full label for tooltip (includes UTC marker when applicable). */
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
  /** Calendar used for bucket boundaries. */
  timeZone: UsageTimeZone;
  /** Present when the series is filtered to a single project. */
  projectId?: string;
  /** First bucket start (wall-clock in `timeZone`). */
  from: string;
  /** One bucket past the last bucket (exclusive end, wall-clock in `timeZone`). */
  to: string;
  buckets: UsageBucket[];
  rows: UsageStatsRow[];
  /** Per-bucket total across all rows (index-aligned). */
  bucketTotalTokens: number[];
  totalTokens: number;
  /** Raw field sums for the same window (dashboard hover 明细). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  runCount: number;
}
