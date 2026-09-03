import { newId } from "../store/db.js";
import type { AgentEvent } from "../types.js";
import { networkGitRoutingObserver } from "./observers/network-git-routing.js";
import type {
  AgentDecisionPayload,
  DecisionContext,
  DecisionObserver,
} from "./types.js";

export type { DecisionContext, DecisionObserver, AgentDecisionPayload };
export { networkGitRoutingObserver };

/** Default observers — register new subsystems here, not in provider mappers. */
export const DEFAULT_DECISION_OBSERVERS: DecisionObserver[] = [
  networkGitRoutingObserver,
];

export interface DecisionPipelineOptions {
  observers?: DecisionObserver[];
  /**
   * Deduplicate observed decisions within a run.
   * Key = `${decisionId}::${callId|summary}`.
   */
  seenKeys?: Set<string>;
}

function dedupeKey(payload: AgentDecisionPayload): string {
  const callId = payload.subject?.callId?.trim();
  const summary = payload.subject?.summary?.trim() ?? "";
  return `${payload.decisionId}::${callId || summary}`;
}

/**
 * Run registered observers against one unified event and return
 * ready-to-persist agent_decision events (same task/run/agent).
 */
export function collectDecisionEvents(
  ctx: DecisionContext,
  event: AgentEvent,
  options: DecisionPipelineOptions = {},
): AgentEvent[] {
  if (event.eventType === "agent_decision") return [];

  const observers = options.observers ?? DEFAULT_DECISION_OBSERVERS;
  const seen = options.seenKeys;
  const out: AgentEvent[] = [];

  for (const observer of observers) {
    let payloads: AgentDecisionPayload[] | null;
    try {
      payloads = observer.observe(ctx, event);
    } catch (err) {
      console.warn(
        `[decisions] observer ${observer.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    if (!payloads?.length) continue;

    for (const payload of payloads) {
      const key = dedupeKey(payload);
      if (seen) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push({
        eventId: newId("evt"),
        taskId: event.taskId,
        runId: event.runId,
        agentId: event.agentId,
        timestamp: new Date().toISOString(),
        eventType: "agent_decision",
        payload: { ...payload },
      });
    }
  }

  return out;
}
