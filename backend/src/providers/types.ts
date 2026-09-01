import type { AgentEvent, CostInfo, TokenUsage } from "../types.js";
import type { PromptImage } from "../attachments.js";

export interface ModelInfo {
  id: string;
  displayName: string;
}

export interface RunPrompt {
  text: string;
  images?: PromptImage[];
}

export interface RunInput {
  taskId: string;
  runId: string;
  /** Empty = create a new agent; non-empty = resume/reuse that agent. */
  agentId: string;
  prompt: RunPrompt;
  cwd: string;
  model?: string;
  /** Conversation mode for this run (Cursor SDK: agent | plan). */
  mode?: "agent" | "plan";
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
  /** SDK agent used for this run (for task binding). */
  agentId?: string;
}

/**
 * Provider-agnostic interface implemented by each agent backend (Cursor today;
 * OpenAI / DeepSeek / ... later). The gateway and Web UI never depend on a
 * concrete SDK.
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
   * Optional: after a process restart, cancel SDK-side runs that were still
   * active for the given agents (our DB already marked them interrupted).
   */
  reconcileAfterRestart?(
    orphans: Array<{ agentId: string; cwd: string }>,
  ): Promise<void>;
  /** Optional: release long-lived resources (e.g. cached agents) on shutdown. */
  dispose?(): void;
}
