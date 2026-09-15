export type TaskStatus = "active" | "completed" | "error";

export type TaskType = "general";

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

/** System-wide agent sandbox root; cwd = `<root>/<project-name>/<taskId>/`. */
export interface WorkspaceConfig {
  /** Absolute path; empty/omit = `/Users/gaolei/agent-workspace`. */
  root?: string;
}

/**
 * One deployment-service contract bound to a project.
 * When gracefulRestart is true, both notify + poll URLs are required.
 */
export interface DeploymentServiceConfig {
  /** Deployment SQLite service id (unique within the project). */
  serviceId: string;
  gracefulRestart?: boolean;
  restartNotifyUrl?: string;
  restartPollUrl?: string;
}

/**
 * Project-level deployment settings (multi-service).
 * Legacy flat fields are accepted on read and migrated to `services`.
 */
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

export interface Project {
  projectId: string;
  name: string;
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
  /** ISO time of the latest user message; drives sidebar sort. */
  lastUserInputAt: string;
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

/** Time-bucket granularity for token-usage series. */
export type UsageGranularity = "hour" | "day" | "week";

/** Calendar used when flooring runs into hour/day/week buckets. */
export type UsageTimeZone = "local" | "utc";

/** A finished run carrying usage, with the task row it belongs to. */
export interface UsageRunSample {
  runId: string;
  taskId: string;
  projectId: string;
  provider: string;
  /** Omitted when the run auto-resolved the provider default model. */
  model?: string;
  createdAt: string;
  completedAt?: string;
  usage: TokenUsage;
}

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
  /** Undefined when the model was auto-resolved (shown as （自动）). */
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
  /** One provider/model row per entry, sorted by totalTokens desc. */
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
