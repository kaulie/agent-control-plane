export type TaskStatus = "active" | "completed" | "error";

export type TaskType = "general";

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
 * Owning department of a project/task. The catalogue lives in the organization
 * service (`GET /api/v1/departments`); we only keep the picked id plus a name
 * snapshot so the UI can still render a label when that service is down.
 */
export interface DepartmentConfig {
  /** Department id as returned by the organization service (e.g. `D0001`). */
  departmentId?: string;
  /** Display name at pick time. */
  departmentName?: string;
}

/** One department row from the organization service. */
export interface DepartmentInfo {
  id: string;
  name: string;
  /** Free-form category, e.g. 研发 / 测试 / 产品. */
  type?: string;
}

/**
 * Result of asking the organization service for its departments. `available:
 * false` means the service could not be reached — the UI then keeps whatever
 * was already stored instead of silently dropping the setting.
 */
export interface DepartmentList {
  available: boolean;
  items: DepartmentInfo[];
  types: string[];
  /** Where the rows came from (base URL), for the "来源" hint. */
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

export interface Project {
  projectId: string;
  name: string;
  /** Git remote/clone URL for this project (https, ssh, or local path). */
  gitRepoUrl?: string;
  /**
   * 项目自己的所属部门（存在 `projects.settings_json` 里）。新建项目时必填；
   * 在这条规则之前建的老项目可能为空，此时不返回该字段。
   */
  department?: DepartmentConfig;
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

/** One run sample for the agent board (usage-aware, unlike `UsageRunSample`). */
export interface AgentRunSample {
  runId: string;
  taskId: string;
  agentId: string;
  provider: string;
  /** Omitted when the run auto-resolved the provider default model. */
  model?: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  usage?: TokenUsage;
  modelCalls: number;
  toolCalls: number;
}

/** Which agents the board lists. */
export type AgentBoardScope = "current" | "all";

/**
 * One agent row of the agent board.
 *
 * An "agent" is one SDK agent instance bound to a task. A task normally has a
 * single current agent (`tasks.agent_id`), but a succession (mode change /
 * unusable session) swaps it — with `scope=all` those replaced agents stay on
 * the board, marked with `supersededAt`.
 */
export interface AgentBoardRow {
  /** SDK agent id (`agent-…` for Cursor, `cls-…` for Cline). */
  agentId: string;
  /**
   * Agent 自己的名称，独立于 task：由 agent id 归一化而来
   * （`agent-7362ceb1-4b5b-…` → `agent-7362ceb1`，`cls-5f7393dd40a44b06` →
   * `cls-5f7393dd`）。task 标题只在 `taskTitle` 里出现，两者不共用。
   */
  agentName: string;
  provider: string;
  /** Task-pinned model, else this agent's latest run model. */
  model?: string;
  projectId: string;
  projectName: string;
  /** 所属部门：task 所属 project 的部门（存在 project settings 里）。 */
  department?: DepartmentConfig;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  taskCreatedAt: string;
  taskWorkspace: string;
  /** This is the task's currently bound agent. */
  current: boolean;
  /** Latest activity of this agent: newest event, else newest run. */
  lastActiveAt?: string;
  /** A run of this agent is running right now. */
  running: boolean;
  /** Summed usage over this agent's runs. */
  tokens: TokenUsage;
  /** Wall-clock time this agent spent inside runs (`runs.duration_ms`). */
  durationMs: number;
  runCount: number;
  /** 累计完成对话轮次：该 agent 已跑完（status = finished）的 run 数，一轮 = 一次 run。 */
  completedRounds: number;
  modelCalls: number;
  toolCalls: number;
  /** Set when a succession replaced this agent. */
  supersededAt?: string;
  supersededReason?: AgentSuccessionReason;
  replacedByAgentId?: string;
}

export interface AgentBoardTotals {
  /** Rows on the board (scope-dependent). */
  agentCount: number;
  /** Rows whose task is not finished. */
  activeAgentCount: number;
  /** Rows with a run in flight. */
  runningAgentCount: number;
  tokens: TokenUsage;
  durationMs: number;
  runCount: number;
  /** Summed 完成对话轮次 across the listed rows. */
  completedRounds: number;
  modelCalls: number;
  toolCalls: number;
}

/** `GET /api/agents` — the agent board payload. */
export interface AgentBoard {
  scope: AgentBoardScope;
  generatedAt: string;
  rows: AgentBoardRow[];
  totals: AgentBoardTotals;
  /** Filter options so the UI can build dropdowns without extra requests. */
  projects: Array<{
    projectId: string;
    name: string;
    department?: DepartmentConfig;
  }>;
  departments: Array<{
    departmentId: string;
    departmentName: string;
    agentCount: number;
  }>;
}

/**
 * Agent 时间线（`GET /api/agents/:agentId/timeline`）里 agent 在某段时间的工作状态。
 *
 * - `thinking` —— 模型侧事件（`thinking` / `agent_response` / `usage` / `status` /
 *   `run_started` / plan 相关）：agent 在生成/思考，没有外部副作用。
 * - `working` —— 工具侧事件（`tool_call_started` / `tool_result` / `file_read` /
 *   `file_edit` / `terminal` / `search`）：agent 真的在动文件 / 跑命令 / 检索。
 * - `idle` —— 其余事件（用户消息、run 结束/取消/出错、agent 替换），以及同一状态
 *   连续超过 `stallMs` 没有任何事件的那部分（疑似卡住 / 等待）。
 */
export type AgentActivityState = "thinking" | "working" | "idle";

/** 一段连续状态；`segments` 首尾相接，正好覆盖 [from, to]。 */
export interface AgentTimelineSegment {
  state: AgentActivityState;
  start: string;
  end: string;
  durationMs: number;
  /** 所属 run（idle 段没有）。 */
  runId?: string;
  /** 这一段里最后一条事件的类型（tooltip / 排查用）。 */
  lastEvent?: EventType;
  /** 这一段是被「无事件超过 stallMs」截断出来的（后面接的是空闲）。 */
  stalled?: boolean;
}

/**
 * 时间跨度太大时不做逐段渲染：按等宽时间桶给出每桶的状态占比。
 * （`mode: "buckets"` 时 `segments` 为空，用 `buckets` 画堆叠柱。）
 */
export interface AgentTimelineBucket {
  start: string;
  end: string;
  thinkingMs: number;
  workingMs: number;
  idleMs: number;
  /** 桶内占比最高的状态（整桶空闲时为 idle）。 */
  dominant: AgentActivityState;
  /** 桶内 run 开始次数 / 用户输入次数。 */
  runCount: number;
  userInputs: number;
}

/** 时间线上的瞬时事件。 */
export type AgentTimelineMarkerKind =
  | "user_input"
  | "run_start"
  | "run_end"
  | "succession"
  | "stall";

export interface AgentTimelineMarker {
  at: string;
  kind: AgentTimelineMarkerKind;
  /** 一行短标签（marker 的 title / 列表用）。 */
  label?: string;
  /** 用户输入原文（`user_input`）。 */
  text?: string;
  mode?: "agent" | "plan";
  imageCount?: number;
  runId?: string;
  /** run 结束时的状态（`run_end`）。 */
  status?: RunStatus;
}

/** 区间内该 agent 的一轮 run（含状态时长拆解）。 */
export interface AgentTimelineRun {
  runId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  /** 这一轮里 thinking / working 的实测时长（来自事件）。 */
  thinkingMs: number;
  workingMs: number;
  modelCalls: number;
  toolCalls: number;
  model?: string;
  /** 触发这一轮的用户输入（同 run 的 `user_message`）。 */
  inputText?: string;
  mode?: "agent" | "plan";
}

export interface AgentTimelineTotals {
  /** 窗口长度（ms）。 */
  spanMs: number;
  thinkingMs: number;
  workingMs: number;
  idleMs: number;
  /** thinking + working。 */
  activeMs: number;
  /** activeMs / spanMs（0~1）。 */
  activeRatio: number;
  runCount: number;
  userInputCount: number;
  toolCalls: number;
  modelCalls: number;
  /** 原始事件按类型计数（窗口内）。 */
  eventCounts: Record<string, number>;
}

/** `GET /api/agents/:agentId/timeline` 的返回体。 */
export interface AgentTimeline {
  agentId: string;
  /** agent 自己的显示名（独立于 task，见 `agentDisplayName`）。 */
  agentName: string;
  provider: string;
  model?: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  department?: DepartmentConfig;
  /** 这个 agent 是否仍是该 task 当前绑定的 agent。 */
  current: boolean;
  /**
   * 这个 agent 自己的「最近活跃时间」（最新事件 / run 结束时间），**不受查询窗口限制**：
   * 前端用它判断「窗口选错了」还是「这个 agent 真的没动过」。
   */
  lastActiveAt?: string;
  from: string;
  to: string;
  generatedAt: string;
  /** 跨度大时退化为 `buckets`（否则 `segments` 逐段精确渲染）。 */
  mode: "segments" | "buckets";
  segments: AgentTimelineSegment[];
  buckets: AgentTimelineBucket[];
  /** 用户输入 / run 起止 / agent 替换 / 疑似停滞 等瞬时事件（两种模式都有）。 */
  markers: AgentTimelineMarker[];
  runs: AgentTimelineRun[];
  totals: AgentTimelineTotals;
  /** 判定口径（前端直接展示，避免"这段为什么算 idle"的疑问）。 */
  note: string;
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
