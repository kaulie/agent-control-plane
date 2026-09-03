import type { AgentEvent } from "../types.js";

/**
 * Read-only snapshot of ambient capability flags for observers.
 * Keep this subsystem-agnostic — add keys only when multiple observers need them.
 */
export interface DecisionContext {
  /** Ambient HTTP proxy URL (empty = disabled). */
  ambientProxyUrl: string;
  /** Whether Shell/gh inherit ambient proxy env. */
  ambientShellProxy: boolean;
  /** Whether an explicit proxied MCP/capability path is available to the agent. */
  mcpProxyAvailable: boolean;
}

/** Stable payload shape for EventType "agent_decision". */
export interface AgentDecisionPayload {
  /** Stable id for the decision class, e.g. "network.git.routing". */
  decisionId: string;
  /** Short choice enum defined by the observer. */
  choice: string;
  /** One-line human rationale. */
  rationale: string;
  /** v1: observed from tool stream; reserved: declared by the agent. */
  source: "observed" | "declared";
  subject?: {
    callId?: string;
    toolType?: string;
    summary?: string;
  };
  evidence?: Record<string, unknown>;
  alternatives?: string[];
}

export interface DecisionObserver {
  readonly id: string;
  /**
   * Inspect a unified AgentEvent and optionally emit agent_decision payloads.
   * Observers must not mutate the input event.
   */
  observe(
    ctx: DecisionContext,
    event: AgentEvent,
  ): AgentDecisionPayload[] | null;
}
