export interface Project {
  projectId: string;
  name: string;
  /** 项目自己的所属部门（新建时必填；老项目可能没有）。 */
  department?: DepartmentConfig;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeConfig {
  defaultProvider?: string;
  defaultModel?: string;
}

/** System-wide agent sandbox root; 每个 agent 的 cwd = `<root>/agent-<agentid>/`. */
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
  | "agent-timeline"
  /** 「交给 autonomy」执行的任务（数据源是 autonomy，控制面只代理）。 */
  | "autonomy";

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

export type TaskType = "general" | "feature" | "bugfix" | "diagnose";

/**
 * 任务目标（见 `./task-goals.ts`）：和前两者不同，它**会改变 agent 的交付动作**。
 * - `merge`：做完合入主分支，不部署；
 * - `deploy`：合入主分支后再部署上线。
 * 老任务（历史数据）没有这个字段 → 按老行为显示（开完 PR 停）。
 */
export type TaskGoal = "merge" | "deploy";

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
  /** 任务类型（纯分类标签，见 `./task-types.ts`）。 */
  taskType: TaskType;
  /** 交付目标（会改变 agent 的动作，见 `./task-goals.ts`）；老任务没有。 */
  goal?: TaskGoal;
  /**
   * 任务描述（需求原文）。新建时必填；创建后可在「任务意图」面板上修改。
   * 老任务可能没有。
   */
  description?: string;
  /** ISO time of the latest user message; drives sidebar sort. */
  lastUserInputAt?: string;
  /** 从哪个 task fork 而来（上下文将满时分流）。 */
  forkedFrom?: string;
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

/** 计费模块（`billing_rules`）算出来的明细。 */
export interface BillingCostInfo {
  ruleId: string;
  provider: string;
  model: string;
  matchedBy: "exact" | "pattern" | "wildcard";
  period: "peak" | "offpeak";
  /** 计费基准时刻（run 起始）。 */
  at: string;
  currency: string;
  usdPerUnit: number;
  /** 本币金额。 */
  amount: number;
  /** 折算后的 USD cents。 */
  usdCents: number;
  prices: Record<string, number>;
  tokens: Record<string, number>;
  breakdown: Record<string, number>;
  offpeakWindow: { startMinute: number; endMinute: number } | null;
}

export interface CostInfo {
  rawCostCents?: number;
  /** provider / SDK 自己上报的成本（USD cents）—— 对比口径。 */
  chargedCents?: number;
  /** 计费表算出来的成本（USD cents）—— 主口径。 */
  estimatedCents?: number;
  currency: string;
  model?: string;
  /**
   * 实际成本（`estimatedCents`）的来源：`rule` = 计费表；
   * `reported` = provider/SDK 上报（没有规则时就是这个，两个口径同值）；`estimate` = 旧估算。
   */
  costSource?: "rule" | "reported" | "estimate";
  /** 计费表明细（命中规则时才有）。 */
  billing?: BillingCostInfo;
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

export type AgentSuccessionReason =
  | "mode_change"
  | "session_unusable"
  /** 上下文接近模型窗口，系统自动换会话（兜底；见 context/README.md）。 */
  | "context_rotation"
  /** 网关重启后按磁盘 transcript 续接（新会话 + seed 旧历史）。 */
  | "gateway_restart";

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
  /** seed 体量（token 估算）；透明化 PR-5 之前只有条数。 */
  seededTokens?: number;
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
  /** 主口径：按计费表 `billing_rules` 算出的成本合计（USD cents）。 */
  costCents?: number;
  /** 主口径的本币金额（币种见 `billedCurrency`）—— 账单就是这个数。 */
  billedAmount?: number;
  billedCurrency?: string;
  /** 对比口径：provider / SDK 上报的成本合计（USD cents），与 `costCents` 分开显示。 */
  chargedCents?: number;
  /** 旧口径（历史本地估算），只为兼容老数据保留。 */
  estimatedCents?: number;
  /** `costCents` 里各来源的 run 数。 */
  costSources?: { rule: number; reported: number; estimate: number };
  currency: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  runCount: number;
}

/** 一轮 run 的上下文轨迹（口径见 backend/src/context/size.ts）。 */
export interface ContextRunSample {
  runId: string;
  at: string;
  model?: string;
  calls: number;
  startTokens: number;
  endTokens: number;
  growthTokens: number;
  /** 这一轮换了会话（重启 / 轮转）。 */
  reset: boolean;
}

/** 上下文体量（`GET /api/tasks/:id` 的 `context`）。 */
export interface TaskContextSize {
  provider: string;
  available: boolean;
  note?: string;
  model?: string;
  limit?: number;
  tokens?: number;
  percent?: number;
  sampledAt?: string;
  runs: ContextRunSample[];
  avgGrowthTokens?: number;
  estimatedRunsLeft?: number;
  thresholds: { warn: number; alert: number };
}

export interface TaskDetail {
  task: Task;
  /** 任务所属项目（名字 / 所属部门 `department`，见 Project）。 */
  project?: Project;
  runs: RunRecord[];
  stats: TaskStats;
  /** 上下文体量（缺失 = 还没有可用的 usage 采样）。 */
  context?: TaskContextSize;
  /** 从这个 task fork 出去的新 task id。 */
  forkedTo?: string[];
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
  displayName: string;  /** 模型上下文窗口（tokens）；未知则缺省。 */
  contextWindow?: number;
  /** 可用输入预算（tokens）。 */
  maxInputTokens?: number;
  /** 单轮最大输出（tokens）。 */
  maxTokens?: number;
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

// ---- 「交给 autonomy」入口（控制面只代理；数据源是 autonomy 本身）---------------

/** 入口开关（`TASK_ENTRY`）：both（默认）/ autonomy（只留新入口）/ gateway（只留老入口）。 */
export type TaskEntry = "both" | "autonomy" | "gateway";

/** `GET /api/autonomy/meta`。 */
export interface AutonomyMeta {
  available: boolean;
  /** autonomy 的 base URL —— 页面上要写清数据源。 */
  url: string;
  version?: string;
  /** 当前 LLM 后端 / 模型（由 autonomy 进程决定，控制面选不了）。 */
  llmBackend?: string;
  llmModel?: string;
  turns?: number;
  error?: string;
  fetchedAt: string;
  entry: TaskEntry;
}

/** `GET /api/autonomy/tasks` 的一行（字段来自 autonomy）。 */
export interface AutonomyTaskSummary {
  id: string;
  description: string;
  status: string;
  turns: number;
  lastAt: string;
  projectId?: string;
  agentId?: number;
  updatedAt?: string;
}

/** `GET /api/autonomy/tasks`。 */
export interface AutonomyTaskList {
  available: boolean;
  tasks: AutonomyTaskSummary[];
  url: string;
  error?: string;
  fetchedAt: string;
  entry: TaskEntry;
}

/** `POST /api/autonomy/tasks` 的 202（autonomy 已受理）。 */
export interface AutonomyAccepted {
  taskId: string;
  agentId?: number;
  status?: string;
  messageId?: number;
  /** 这条指令前面还有几条没处理完（含正在跑的那条）。 */
  queued?: number;
  url: string;
  entry: TaskEntry;
}

/** `GET /api/autonomy/tasks/{id}`：autonomy 的详情**原样**透传（字段由它决定，我们只挑着渲染）。 */
export type AutonomyTaskDetail = Record<string, unknown> & {
  task_id?: string;
  description?: string;
  status?: string;
  error?: string;
  domain?: string;
  goal_type?: string;
  context_ref?: Record<string, unknown>;
  agent_id?: number;
  created_at?: string;
  updated_at?: string;
  project?: {
    id?: string;
    name?: string;
    git_repo_url?: string;
    organization?: { id?: string; name?: string };
  };
  plans?: Array<{
    id?: number;
    steps?: Array<{
      status?: string;
      capability?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    }>;
  }>;
  /** 控制面读它的时刻（代理加的）。 */
  fetchedAt?: string;
};
