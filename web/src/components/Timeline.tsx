import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../types";
import { formatTime, truncate } from "../format";

const ICONS: Record<string, string> = {
  user_message: "👤",
  run_started: "🚀",
  status: "⚙️",
  thinking: "💭",
  agent_response: "🤖",
  tool_call_started: "🔧",
  tool_result: "🧰",
  file_read: "📖",
  file_edit: "✏️",
  terminal: "🖥️",
  search: "🔍",
  usage: "📊",
  run_completed: "✅",
  run_cancelled: "⏹",
  run_error: "❌",
};

const LABELS: Record<string, string> = {
  user_message: "User",
  run_started: "Agent started",
  status: "Status",
  thinking: "Thinking",
  agent_response: "Assistant",
  tool_call_started: "Tool call",
  tool_result: "Tool result",
  file_read: "File read",
  file_edit: "File edit",
  terminal: "Terminal",
  search: "Search",
  usage: "Usage",
  run_completed: "Completed",
  run_cancelled: "Stopped",
  run_error: "Error",
};

function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  if (typeof a.pattern === "string") return a.pattern;
  if (typeof a.file_path === "string") return a.file_path;
  return truncate(JSON.stringify(args), 160);
}

function resultSummary(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as {
    status?: string;
    value?: Record<string, unknown>;
    error?: unknown;
  };
  if (r.status === "error") {
    return `error: ${truncate(String(r.error ?? "unknown"), 200)}`;
  }
  const v = r.value;
  if (!v) return truncate(JSON.stringify(result), 240);
  if (typeof v.stdout === "string") return truncate(v.stdout || "(empty)", 600);
  if (typeof v.content === "string") return truncate(v.content, 600);
  if (typeof v.output === "string") return truncate(v.output, 600);
  if (v.matches != null) {
    const n = Array.isArray(v.matches) ? v.matches.length : v.matches;
    return `${n} matches`;
  }
  return truncate(JSON.stringify(v), 240);
}

/** Short display form: agent-4e559024-… → agent-4e559024 */
function shortAgentId(id: string): string {
  const m = id.match(/^(?:agent-)?([0-9a-f]{8})/i);
  if (m) return `agent-${m[1].toLowerCase()}`;
  return id.length > 20 ? `${id.slice(0, 20)}…` : id;
}

interface Row {
  key: string;
  time: string;
  type: string;
  label: string;
  icon: string;
  body: string;
  detail: string;
  agentId: string;
}

function buildRows(events: AgentEvent[]): Row[] {
  const rows: Row[] = [];
  for (const ev of events) {
    const type = ev.eventType;
    const p = ev.payload;
    let body = "";
    let detail = "";

    switch (type) {
      case "user_message":
        body = String(p.text ?? "");
        break;
      case "run_started":
        body = String(p.model ?? "agent");
        detail = p.cwd ? String(p.cwd) : "";
        break;
      case "status":
        body = String(p.status ?? "");
        detail = p.message ? String(p.message) : "";
        break;
      case "thinking":
        body = String(p.text ?? "");
        break;
      case "agent_response":
        body = String(p.text ?? "");
        break;
      case "tool_call_started":
        body = String(p.toolType ?? "");
        detail = argSummary(p.args);
        break;
      case "file_read":
      case "file_edit":
      case "terminal":
      case "search":
      case "tool_result":
        body = String(p.toolType ?? type);
        detail = argSummary(p.args);
        if (p.result) {
          const rs = resultSummary(p.result);
          if (rs) detail = detail ? `${detail}\n${rs}` : rs;
        }
        break;
      case "usage":
        body = ev.usage ? `${ev.usage.totalTokens} tokens` : "";
        break;
      case "run_completed":
        body = String(p.result ?? "");
        detail = `duration ${p.durationMs ?? "?"}ms`;
        break;
      case "run_cancelled":
        body = "Stopped by user";
        detail = p.durationMs != null ? `duration ${p.durationMs}ms` : "";
        break;
      case "run_error":
        body = String(p.error ?? "error");
        break;
      default:
        body = truncate(JSON.stringify(p), 300);
    }

    const last = rows[rows.length - 1];
    if (last && type === "thinking" && last.type === "thinking") {
      last.body += body;
      if (!last.agentId && ev.agentId) last.agentId = ev.agentId;
      continue;
    }
    if (last && type === "agent_response" && last.type === "agent_response") {
      last.body += body;
      if (!last.agentId && ev.agentId) last.agentId = ev.agentId;
      continue;
    }

    rows.push({
      key: ev.eventId,
      time: formatTime(ev.timestamp),
      type,
      label: LABELS[type] ?? type,
      icon: ICONS[type] ?? "•",
      body,
      detail,
      agentId: ev.agentId ?? "",
    });
  }
  return rows;
}

const NEAR_BOTTOM_PX = 80;

export default function Timeline({
  events,
  running,
}: {
  events: AgentEvent[];
  running: boolean;
}) {
  const rows = useMemo(() => buildRows(events), [events]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  const stickToBottomRef = useRef(true);

  const updateJumpVisibility = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance <= NEAR_BOTTOM_PX;
    stickToBottomRef.current = nearBottom;
    setShowJump(!nearBottom && el.scrollHeight > el.clientHeight + 4);
  };

  const scrollToBottom = (smooth = true): void => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    stickToBottomRef.current = true;
    setShowJump(false);
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = (): void => updateJumpVisibility();
    el.addEventListener("scroll", onScroll, { passive: true });
    updateJumpVisibility();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Keep following the latest events while the user is already near the bottom.
  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom(false);
    } else {
      updateJumpVisibility();
    }
  }, [rows, running]);

  return (
    <div className="timeline-wrap">
      <div className="timeline" ref={scrollerRef}>
        {rows.map((r) => (
          <div key={r.key} className={`event event-${r.type}`}>
            <div className="event-head">
              <span className="event-icon">{r.icon}</span>
              <span className="event-label">{r.label}</span>
              <span className="event-time">{r.time}</span>
            </div>
            {r.body && <div className="event-body">{r.body}</div>}
            {r.detail && <pre className="event-detail">{r.detail}</pre>}
            {r.type === "agent_response" && r.agentId && (
              <div className="event-agent-id" title={r.agentId}>
                {shortAgentId(r.agentId)}
              </div>
            )}
          </div>
        ))}
        {running && (
          <div className="event event-running">
            <span className="spinner" /> Agent is working…
          </div>
        )}
        {!running && rows.length === 0 && (
          <div className="timeline-empty">No activity yet — send a message below.</div>
        )}
      </div>
      {showJump && (
        <button
          type="button"
          className="scroll-bottom-btn"
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          onClick={() => scrollToBottom(true)}
        >
          ↓
        </button>
      )}
    </div>
  );
}
