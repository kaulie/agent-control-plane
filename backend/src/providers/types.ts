import type { AgentEvent, CostInfo, TokenUsage } from "../types.js";
import type { PromptImage } from "../attachments.js";
import type { TaskBootstrap } from "../task-context.js";

export interface ModelInfo {
  id: string;
  displayName: string;
  /** 模型上下文窗口（tokens）；来自 provider 的模型目录，未知则缺省。 */
  contextWindow?: number;
  /** 可用输入预算（tokens）；SDK 的 `resolveEffectiveMaxInputTokens` 优先用它。 */
  maxInputTokens?: number;
  /** 单轮最大输出（tokens）。 */
  maxTokens?: number;
}

export interface RunPrompt {
  text: string;
  images?: PromptImage[];
}

/** 会话体量 + 轮转开关（`RunInput.sessionContext`）。 */
export interface RunSessionContext {
  /** 当前会话请求体量（tokens）；未知则不给（provider 也就不会轮转）。 */
  tokens?: number;
  /** 模型窗口（tokens）。 */
  limit?: number;
  /** 本次用户输入（文本 + 图片）的估算 tokens。 */
  incomingTokens?: number;
  /** 最近几轮平均增量（tokens/run），给日志/事件用。 */
  avgGrowthTokens?: number;
  /** 上一次 run 因上下文超限失败 → 无条件轮转。 */
  lastRunOverflow?: boolean;
  /** 自动轮转总开关（`CONTEXT_AUTO_ROTATE=0` 关掉）。 */
  autoRotate?: boolean;
}

export interface RunInput {
  taskId: string;
  runId: string;
  /**
   * Opaque session handle for the adapter.
   * Empty = create a new session; non-empty = resume/reuse that session.
   */
  agentId: string;
  prompt: RunPrompt;
  cwd: string;
  model?: string;
  /**
   * Product conversation mode for this run (`agent` | `plan`).
   * The concrete adapter maps this onto its runtime if supported.
   */
  mode?: "agent" | "plan";
  /**
   * Task briefing prepended only when this run actually creates a new session
   * (first bind, resume-fail recreate, or busy-fallback fresh agent).
   * Not shown in the Web Cursor timeline.
   */
  bootstrapText?: string;
  /**
   * 简报的体检数据（字符数 / 有没有因超预算丢历史行）。
   * provider 会把它写进 `run_started` 事件，页面/接口因此能回答"模型到底看到了什么"。
   */
  bootstrap?: TaskBootstrap;
  /**
   * 会话体量快照（网关算好给 provider 用）：自动轮转兜底的判据。
   * 口径见 `context/size.ts`（tokens = 最近一次模型调用的 prompt）。
   */
  sessionContext?: RunSessionContext;
  /** Display name for the underlying session (typically task.title). */
  agentName?: string;
  onEvent: (event: AgentEvent) => Promise<void> | void;
}

export interface RunResultData {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: string;
  durationMs?: number;
  usage?: TokenUsage;
  cost?: CostInfo;
  modelCalls: number;
  toolCalls: number;
  /** Session handle used for this run (for task binding). */
  agentId?: string;
}

/**
 * Swappable agent runtime adapter.
 *
 * Gateway / HTTP / Web UI depend only on this interface — never on a concrete
 * SDK. Cursor today lives in `providers/cursor/`; add another runtime by
 * implementing this interface and registering it in `createProvider`.
 */
export interface AgentProvider {
  readonly name: string;
  verifyAuth(): Promise<{ ok: boolean; detail: string }>;
  listModels(): Promise<ModelInfo[]>;
  resolveModel(): Promise<string | undefined>;
  run(input: RunInput): Promise<RunResultData>;
  /** Request cancellation of an in-flight run. Returns false if unknown. */
  cancel(runId: string): Promise<boolean>;
  /**
   * Optional: after a process restart, cancel underlying runs that were still
   * active for the given sessions (our DB already marked them interrupted).
   */
  reconcileAfterRestart?(
    orphans: Array<{ agentId: string; cwd: string }>,
  ): Promise<void>;
  /** Optional: release long-lived resources (e.g. cached sessions) on shutdown. */
  dispose?(): void;
}
