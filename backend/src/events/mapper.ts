import type {
  SDKMessage,
  SDKToolUseMessage,
  TextBlock,
  ToolUseBlock,
} from "@cursor/sdk";
import type { EventType, TokenUsage } from "../types.js";
import { formatRunErrorMessage } from "../run-errors.js";

export interface MappedEvent {
  eventType: EventType;
  payload: Record<string, unknown>;
  usage?: TokenUsage;
}

export function textOfContent(
  content: Array<TextBlock | ToolUseBlock> | undefined,
): string {
  if (!content) return "";
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Map a raw Cursor tool name to a unified, display-friendly event type. */
export function toolEventType(toolName: string): EventType {
  switch (toolName) {
    case "read":
      return "file_read";
    case "edit":
    case "write":
    case "applyAgentDiff":
      return "file_edit";
    case "shell":
      return "terminal";
    case "grep":
    case "glob":
    case "semSearch":
    case "webSearch":
    case "webFetch":
      return "search";
    default:
      return "tool_result";
  }
}

function mapToolCall(msg: SDKToolUseMessage): MappedEvent[] {
  const toolType = msg.name;
  if (msg.status === "running") {
    return [
      {
        eventType: "tool_call_started",
        payload: { callId: msg.call_id, toolType, args: msg.args },
      },
    ];
  }
  return [
    {
      eventType: toolEventType(toolType),
      payload: {
        callId: msg.call_id,
        toolType,
        args: msg.args,
        result: msg.result,
        status: msg.status,
        truncated: msg.truncated,
      },
    },
  ];
}

/** Convert one Cursor SDKMessage into zero or more unified AgentEvent pieces. */
export function mapSdkMessage(msg: SDKMessage): MappedEvent[] {
  switch (msg.type) {
    case "system":
      // run_started is emitted by the adapter itself (with cwd/model context).
      return [];
    case "user":
      // The gateway emits an authoritative user_message event before the run.
      return [];

    case "assistant": {
      const text = textOfContent(msg.message.content);
      return text ? [{ eventType: "agent_response", payload: { text } }] : [];
    }
    case "thinking":
      return [
        {
          eventType: "thinking",
          payload: { text: msg.text, durationMs: msg.thinking_duration_ms },
        },
      ];
    case "tool_call":
      return mapToolCall(msg);
    case "status": {
      const status = String(msg.status ?? "");
      const rawMessage =
        typeof msg.message === "string" ? msg.message : undefined;
      const message =
        status.toLowerCase() === "error" || /cancel/i.test(status)
          ? formatRunErrorMessage(rawMessage ?? status)
          : rawMessage;
      return [
        {
          eventType: "status",
          payload: { status, ...(message ? { message } : {}) },
        },
      ];
    }
    case "usage":
      return [{ eventType: "usage", payload: {}, usage: msg.usage }];
    case "task":
      return [
        {
          eventType: "tool_result",
          payload: { toolType: "task", status: msg.status, text: msg.text },
        },
      ];
    case "request":
    default:
      return [];
  }
}
