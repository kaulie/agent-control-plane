import type { AgentEvent, CostInfo, TokenUsage } from "../types.js";

export interface ModelInfo {
  id: string;
  displayName: string;
}

export interface RunInput {
  taskId: string;
  runId: string;
  agentId: string;
  prompt: string;
  cwd: string;
  model?: string;
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
}
