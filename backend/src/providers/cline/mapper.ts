import type { AgentEvent as ClineAgentEvent } from "@cline/sdk";
import type { EventType, TokenUsage } from "../../types.js";
import { tokenVolume } from "../../usage/tokens.js";

export interface MappedEvent {
  eventType: EventType;
  payload: Record<string, unknown>;
  usage?: TokenUsage;
}

export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokenCount?: number;
  totalCost?: number;
}

export function toTokenUsage(u: UsageLike): TokenUsage {
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const cacheReadTokens = u.cacheReadTokens ?? 0;
  const cacheWriteTokens = u.cacheWriteTokens ?? 0;
  // inputTokens is the full prompt (cache included); cache_* are breakdown only.
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: tokenVolume(
      { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
      "cline",
    ),
    ...(typeof u.reasoningTokenCount === "number"
      ? { reasoningTokens: u.reasoningTokenCount }
      : {}),
  };
  return usage;
}

/** Map a Cline tool name to the unified, display-friendly event type. */
export function toolEventType(toolName: string): EventType {
  const t = (toolName || "").toLowerCase();
  if (/bash|shell|exec|command|terminal|run/.test(t)) return "terminal";
  if (/write|edit|patch|apply|create|update|delete|remove|rename|replace|save/.test(t)) {
    return "file_edit";
  }
  if (/search|grep|find|fetch|web|glob|semantic/.test(t)) return "search";
  if (/read|list|view|cat|open|show/.test(t)) return "file_read";
  return "tool_result";
}

/** Convert one Cline host-facing AgentEvent into zero+ unified event pieces. */
export function mapAgentEvent(event: ClineAgentEvent): MappedEvent[] {
  switch (event.type) {
    case "content_start": {
      if (event.contentType === "tool") {
        return [
          {
            eventType: "tool_call_started",
            payload: {
              callId: event.toolCallId,
              toolType: event.toolName,
              args: event.input,
            },
          },
        ];
      }
      return [];
    }
    case "content_end": {
      if (event.contentType === "text") {
        return event.text
          ? [{ eventType: "agent_response", payload: { text: event.text } }]
          : [];
      }
      if (event.contentType === "reasoning") {
        return event.reasoning
          ? [{ eventType: "thinking", payload: { text: event.reasoning } }]
          : [];
      }
      if (event.contentType === "tool") {
        const toolType = event.toolName ?? "";
        return [
          {
            eventType: toolEventType(toolType),
            payload: {
              callId: event.toolCallId,
              toolType,
              result: event.output,
              ...(event.error ? { error: event.error } : {}),
              ...(typeof event.durationMs === "number"
                ? { durationMs: event.durationMs }
                : {}),
            },
          },
        ];
      }
      return [];
    }
    case "usage": {
      const usage = toTokenUsage({
        inputTokens: event.totalInputTokens,
        outputTokens: event.totalOutputTokens,
        cacheReadTokens: event.totalCacheReadTokens,
        cacheWriteTokens: event.totalCacheWriteTokens,
      });
      return [{ eventType: "usage", payload: {}, usage }];
    }
    case "notice": {
      return [
        {
          eventType: "status",
          payload: { status: event.noticeType, message: event.message },
        },
      ];
    }
    case "iteration_start":
    case "iteration_end":
    case "done":
    case "error":
      return [];
    default:
      return [];
  }
}
