import type { AgentEvent, CostInfo, TokenUsage } from "../types.js";
import type { PromptImage } from "../attachments.js";

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
