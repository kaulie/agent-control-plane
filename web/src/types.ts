export interface Project {
  projectId: string;
  name: string;
  /** Git remote/clone URL for this project. */
  gitRepoUrl?: string;
  /** 项目自己的所属部门（新建时必填；老项目可能没有）。 */
  department?: DepartmentConfig;
  createdAt: string;
  updatedAt: string;
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

/**
 * Owning department of a project. Catalogue comes from the organization service
 * (`GET /api/org/departments`); we store the id plus the name at pick time.
 */
export interface DepartmentConfig {
  departmentId?: string;
  departmentName?: string;
}

/** One department row returned by the organization service (via the gateway). */
export interface DepartmentInfo {
  id: string;
  name: string;
  /** Free-form category, e.g. 研发 / 测试 / 产品. */
  type?: string;
}

export interface DepartmentList {
  /** false when the organization service could not be reached. */
  available: boolean;
  items: DepartmentInfo[];
  types: string[];
  source: string;
  fetchedAt: string;
  error?: string;
}

export interface AppSettings {
  runtime?: RuntimeConfig;
  workspace?: WorkspaceConfig;
  department?: DepartmentConfig;
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
  | "agent-runtime"
  | "agent-board"
  | "agent-timeline";

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

// ---- Agent 时间线（idle / thinking / working + 用户 input）----

/** agent 某段时间的工作状态。 */
export type AgentActivityState = "thinking" | "working" | "idle";

/** 一段连续状态；`segments` 首尾相接，正好覆盖 [from, to]。 */
export interface AgentTimelineSegment {
  state: AgentActivityState;
  start: string;
  end: string;
  durationMs: number;
  /** 所属 run（idle 段没有）。 */
  runId?: string;
  /** 这一段里最后一条事件的类型。 */
  lastEvent?: string;
  /** 被「无事件超过 stall 阈值」截断（后面接的是空闲）。 */
  stalled?: boolean;
}

/** 跨度太大时的时间桶（`mode === "buckets"`）。 */
export interface AgentTimelineBucket {
  start: string;
  end: string;
  thinkingMs: number;
  workingMs: number;
  idleMs: number;
  dominant: AgentActivityState;
  runCount: number;
  userInputs: number;
}

export type AgentTimelineMarkerKind =
  | "user_input"
  | "run_start"
  | "run_end"
  | "succession"
  | "stall";

/** 时间线上的瞬时事件（用户输入 / run 起止 / agent 替换 / 疑似停滞）。 */
export interface AgentTimelineMarker {
  at: string;
  kind: AgentTimelineMarkerKind;
  label?: string;
  /** 用户输入原文（`user_input`）。 */
  text?: string;
  mode?: "agent" | "plan";
  imageCount?: number;
  runId?: string;
  status?: "queued" | "running" | "finished" | "error" | "cancelled";
}

/** 区间内该 agent 的一轮 run。 */
export interface AgentTimelineRun {
  runId: string;
  status: "queued" | "running" | "finished" | "error" | "cancelled";
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  thinkingMs: number;
  workingMs: number;
  modelCalls: number;
  toolCalls: number;
  model?: string;
  inputText?: string;
  mode?: "agent" | "plan";
}

export interface AgentTimelineTotals {
  spanMs: number;
  thinkingMs: number;
  workingMs: number;
  idleMs: number;
  activeMs: number;
  activeRatio: number;
  runCount: number;
  userInputCount: number;
  toolCalls: number;
  modelCalls: number;
  eventCounts: Record<string, number>;
}

/** `GET /api/agents/:agentId/timeline`。 */
export interface AgentTimeline {
  agentId: string;
  agentName: string;
  provider: string;
  model?: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  department?: DepartmentConfig;
  current: boolean;
  /** 这个 agent 自己的最近活跃时间（不受查询窗口限制）。 */
  lastActiveAt?: string;
  /** 这个 agent 自己的累计（不受窗口限制）：窗口内的「run 轮次」会小很多。 */
  agentRunCount: number;
  agentCompletedRounds: number;
  from: string;
  to: string;
  generatedAt: string;
  mode: "segments" | "buckets";
  segments: AgentTimelineSegment[];
  buckets: AgentTimelineBucket[];
  markers: AgentTimelineMarker[];
  runs: AgentTimelineRun[];
  totals: AgentTimelineTotals;
  note: string;
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

/**
 * 看板的行范围：`current` = 每个 task 当前那个 agent；`all` = 所有 agent 实例
 * （含被 succession 替换掉的）；`task` = 每个 task 一行，数字跨它历史上所有 agent。
 */
export type AgentBoardScope = "current" | "all" | "task";

/** 一个 task 的累计（跨它历史上所有 agent 实例）。 */
export interface AgentBoardTaskTotals {
  completedRounds: number;
  runCount: number;
  totalTokens: number;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  /** 这个 task 历史上换过多少个 agent 实例。 */
  agentCount: number;
}

/**
 * One agent row of the agent board (`GET /api/agents`).
 *
 * agent = 绑定在 task 上的一个 SDK agent 实例；同一个 task 因 succession（模式切换 /
 * 会话不可用）可以换过多个 agent，`scope=all` 时都列出来。
 */
export interface AgentBoardRow {
  agentId: string;
  /**
   * Agent 自己的名称（独立于 task，由 agent id 归一化：
   * `agent-7362ceb1-…` → `agent-7362ceb1`，`cls-5f7393dd40a44b06` → `cls-5f7393dd`）。
   * task 标题只在 `taskTitle` 里。
   */
  agentName: string;
  provider: string;
  model?: string;
  projectId: string;
  projectName: string;
  /** 所属部门：task 所属 project 的部门。 */
  department?: DepartmentConfig;
  taskId: string;
  taskTitle: string;
  taskStatus: "active" | "completed" | "error";
  taskCreatedAt: string;
  taskWorkspace: string;
  /** 是否是 task 当前绑定的 agent。 */
  current: boolean;
  /** 最后活跃时间（该 agent 最新事件 / run）。 */
  lastActiveAt?: string;
  /** 有 run 正在跑。 */
  running: boolean;
  tokens: TokenUsage;
  /** 累计工作时长（该 agent 自己 run 的 duration 之和）。 */
  durationMs: number;
  runCount: number;
  /** 累计完成对话轮次（status = finished 的 run 数）。 */
  completedRounds: number;
  modelCalls: number;
  toolCalls: number;
  supersededAt?: string;
  supersededReason?: AgentSuccessionReason;
  replacedByAgentId?: string;
  /** 这个 task 的累计（跨所有 agent 实例）——per-agent 的数字会明显更小。 */
  taskTotals?: AgentBoardTaskTotals;
  /** = taskTotals.agentCount。 */
  agentCount?: number;
  /** scope=task 的行：整行代表 task，不是某一个 agent。 */
  taskScope?: boolean;
  /** task 行：当前绑定的 agent。 */
  currentAgentId?: string;
}

export interface AgentBoardTotals {
  agentCount: number;
  activeAgentCount: number;
  runningAgentCount: number;
  tokens: TokenUsage;
  durationMs: number;
  runCount: number;
  /** 所有列出 agent 的完成轮次之和。 */
  completedRounds: number;
  modelCalls: number;
  toolCalls: number;
}

export interface AgentBoard {
  scope: AgentBoardScope;
  generatedAt: string;
  rows: AgentBoardRow[];
  totals: AgentBoardTotals;
  projects: Array<{
    projectId: string;
    name: string;
    department?: DepartmentConfig;
  }>;
  /** 部门筛选项（departmentId 为空 = 未设置部门）。 */
  departments: Array<{
    departmentId: string;
    departmentName: string;
    agentCount: number;
  }>;
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
