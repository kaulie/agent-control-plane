import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../types";
import { formatTime, truncate, formatDuration } from "../format";
import { formatRunErrorMessage } from "../run-errors";

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
  plan_exported: "📄",
};

const LABELS: Record<string, string> = {
  user_message: "You",
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
  plan_exported: "Plan exported",
};

type EventRole = "user" | "assistant" | "activity";

function eventRole(type: string): EventRole {
  if (type === "user_message") return "user";
  if (type === "agent_response") return "assistant";
  return "activity";
}

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
  role: EventRole;
  label: string;
  icon: string;
  body: string;
  detail: string;
  agentId: string;
  taskId: string;
  runId: string;
  images: Array<{ id: string; mimeType: string }>;
  mode?: "agent" | "plan";
  queued?: boolean;
}

function buildRows(events: AgentEvent[]): Row[] {
  const rows: Row[] = [];
  for (const ev of events) {
    const type = ev.eventType;
    const p = ev.payload;
    let body = "";
    let detail = "";
    let images: Array<{ id: string; mimeType: string }> = [];

    switch (type) {
      case "user_message": {
        body = String(p.text ?? "");
        const raw = p.images;
        if (Array.isArray(raw)) {
          images = raw
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const o = item as Record<string, unknown>;
              if (typeof o.id !== "string") return null;
              return {
                id: o.id,
                mimeType: typeof o.mimeType === "string" ? o.mimeType : "image/*",
              };
            })
            .filter((x): x is { id: string; mimeType: string } => x != null);
        }
        break;
      }
      case "run_started":
        body = String(p.model ?? "agent");
        detail = p.cwd ? String(p.cwd) : "";
        break;
      case "status": {
        const statusRaw = String(p.status ?? "");
        if (statusRaw.toLowerCase() === "error" || /cancel/i.test(statusRaw)) {
          body = formatRunErrorMessage(
            String(p.message ?? statusRaw),
          );
        } else {
          body = statusRaw;
          detail = p.message ? String(p.message) : "";
        }
        break;
      }
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
        // SDK `result` usually duplicates the last assistant message — show only timing.
        body =
          p.durationMs != null
            ? `耗时 ${formatDuration(Number(p.durationMs))}`
            : "已完成";
        break;
      case "run_cancelled":
        if (p.reason === "server_restart") {
          body = String(
            p.message ??
              "任务因服务重启中断。状态已同步为结束，可继续发消息接着做。",
          );
          detail =
            p.durationMs != null
              ? `耗时 ${formatDuration(Number(p.durationMs))}`
              : "";
        } else if (p.reason === "user_stop") {
          body =
            p.durationMs != null
              ? `已手动停止 · 耗时 ${formatDuration(Number(p.durationMs))}`
              : "已手动停止";
        } else {
          body =
            p.durationMs != null
              ? `已停止 · 耗时 ${formatDuration(Number(p.durationMs))}`
              : "已停止";
        }
        break;
      case "run_error":
        body = formatRunErrorMessage(String(p.error ?? "error"));
        break;
      case "plan_exported":
        body = String(p.path ?? p.fileName ?? "exported");
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

    let mode: "agent" | "plan" | undefined;
    if (p.mode === "plan" || p.mode === "agent") {
      mode = p.mode;
    }
    const queued = type === "user_message" && p.queued === true;

    rows.push({
      key: ev.eventId,
      time: formatTime(ev.timestamp),
      type,
      role: eventRole(type),
      label: LABELS[type] ?? type,
      icon: ICONS[type] ?? "•",
      body,
      detail,
      agentId: ev.agentId ?? "",
      taskId: ev.taskId,
      runId: ev.runId,
      images,
      mode,
      queued,
    });
  }
  return rows;
}

const NEAR_BOTTOM_PX = 80;
const AUTO_FOLD_KEY = "web-cursor:autoFoldActivity";

/** Consecutive runs of these activity types collapse into one expandable group. */
const GROUPABLE_TYPES = new Set([
  "tool_call_started",
  "tool_result",
  "file_read",
  "file_edit",
  "terminal",
  "search",
]);

type TimelineItem =
  | { kind: "row"; row: Row }
  | { kind: "group"; key: string; rows: Row[] };

function groupConsecutiveRows(rows: Row[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!GROUPABLE_TYPES.has(row.type)) {
      out.push({ kind: "row", row });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j].type === row.type) j += 1;
    const chunk = rows.slice(i, j);
    if (chunk.length >= 2) {
      out.push({ kind: "group", key: `grp-${chunk[0].key}`, rows: chunk });
    } else {
      out.push({ kind: "row", row: chunk[0] });
    }
    i = j;
  }
  return out;
}

function loadAutoFold(): boolean {
  try {
    const v = localStorage.getItem(AUTO_FOLD_KEY);
    if (v === null) return true;
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

function storeAutoFold(on: boolean): void {
  try {
    localStorage.setItem(AUTO_FOLD_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function RunningBanner({ running, queueLength }: { running: boolean; queueLength: number }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) {
      startedRef.current = null;
      setElapsedMs(0);
      return;
    }
    if (startedRef.current == null) startedRef.current = Date.now();
    const tick = (): void => {
      setElapsedMs(Date.now() - (startedRef.current ?? Date.now()));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running) return null;
  return (
    <div className="event event-running" aria-live="polite">
      <span className="spinner" />
      Agent 仍在工作中（不是卡死）… 已运行 {formatDuration(elapsedMs)}
      {queueLength > 0 && (
        <span className="queue-hint"> · {queueLength} 条消息排队中</span>
      )}
    </div>
  );
}

function activitySummary(r: Row): string {
  const bits = [r.body, r.detail].filter(Boolean).join(" · ");
  return bits ? truncate(bits.replace(/\s+/g, " "), 120) : "";
}

function EventCard({
  row,
  collapsed,
  onToggle,
  groupCount,
  groupExpanded,
  onGroupToggle,
}: {
  row: Row;
  collapsed: boolean;
  onToggle?: () => void;
  /** When set, this card represents a collapsed group (show count badge). */
  groupCount?: number;
  groupExpanded?: boolean;
  onGroupToggle?: () => void;
}) {
  const foldable = row.role === "activity";
  const isGroupProxy = groupCount != null && groupCount > 1 && !groupExpanded;
  const showToggle = (foldable && onToggle != null) || isGroupProxy;
  const summary = activitySummary(row);

  const handleHeadClick = (): void => {
    if (isGroupProxy && onGroupToggle) {
      onGroupToggle();
      return;
    }
    onToggle?.();
  };

  return (
    <div
      className={`event event-${row.type} event-${row.role}${
        collapsed ? " event-collapsed" : ""
      }${isGroupProxy ? " event-group-proxy" : ""}`}
    >
      <div
        className={`event-head${showToggle ? " event-head-toggle" : ""}`}
        onClick={showToggle ? handleHeadClick : undefined}
        onKeyDown={
          showToggle
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleHeadClick();
                }
              }
            : undefined
        }
        role={showToggle ? "button" : undefined}
        tabIndex={showToggle ? 0 : undefined}
        aria-expanded={
          isGroupProxy ? false : showToggle ? !collapsed : undefined
        }
      >
        {showToggle && (
          <span className="event-chevron" aria-hidden>
            {isGroupProxy || collapsed ? "▸" : "▾"}
          </span>
        )}
        <span className="event-icon">{row.icon}</span>
        <span className="event-label">{row.label}</span>
        {groupCount != null && groupCount > 1 && (
          <span className="event-group-count" title={`${groupCount} 项同类操作`}>
            ×{groupCount}
          </span>
        )}
        {row.mode && (
          <span className={`event-mode event-mode-${row.mode}`}>
            {row.mode === "plan" ? "Plan" : "Agent"}
          </span>
        )}
        {row.queued && <span className="event-queued">排队中</span>}
        {collapsed && summary && (
          <span className="event-summary" title={summary}>
            {summary}
          </span>
        )}
        <span className="event-time">{row.time}</span>
      </div>
      {!collapsed && (
        <>
          {row.images.length > 0 && (
            <div className="event-images">
              {row.images.map((img) => (
                <a
                  key={img.id}
                  href={`/api/tasks/${row.taskId}/attachments/${img.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="event-image-link"
                >
                  <img
                    src={`/api/tasks/${row.taskId}/attachments/${img.id}`}
                    alt="User attachment"
                    className="event-image"
                  />
                </a>
              ))}
            </div>
          )}
          {row.body && <div className="event-body">{row.body}</div>}
          {row.detail && <pre className="event-detail">{row.detail}</pre>}
          {row.type === "agent_response" && row.agentId && (
            <div className="event-agent-id" title={row.agentId}>
              {shortAgentId(row.agentId)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EventGroup({
  groupKey,
  rows,
  expanded,
  onToggleGroup,
  autoFold,
  expandedItems,
  onToggleItem,
}: {
  groupKey: string;
  rows: Row[];
  expanded: boolean;
  onToggleGroup: () => void;
  autoFold: boolean;
  expandedItems: Record<string, boolean>;
  onToggleItem: (key: string) => void;
}) {
  const last = rows[rows.length - 1];
  const count = rows.length;

  if (!expanded) {
    return (
      <EventCard
        row={last}
        collapsed={Boolean(autoFold && !expandedItems[last.key])}
        onToggle={autoFold ? () => onToggleItem(last.key) : undefined}
        groupCount={count}
        groupExpanded={false}
        onGroupToggle={onToggleGroup}
      />
    );
  }

  return (
    <div className="event-group" data-group-key={groupKey}>
      <button
        type="button"
        className="event-group-head"
        onClick={onToggleGroup}
        aria-expanded
      >
        <span className="event-chevron" aria-hidden>
          ▾
        </span>
        <span className="event-icon">{last.icon}</span>
        <span className="event-label">{last.label}</span>
        <span className="event-group-count">{count} 项</span>
        <span className="event-time">{rows[0].time}</span>
        {rows.length > 1 && rows[0].time !== last.time && (
          <span className="event-group-time-end">– {last.time}</span>
        )}
      </button>
      <div className="event-group-items">
        {rows.map((r) => {
          const foldable = r.role === "activity";
          const collapsed = Boolean(autoFold && foldable && !expandedItems[r.key]);
          return (
            <EventCard
              key={r.key}
              row={r}
              collapsed={collapsed}
              onToggle={
                foldable && autoFold ? () => onToggleItem(r.key) : undefined
              }
            />
          );
        })}
      </div>
    </div>
  );
}

export default function Timeline({
  events,
  running,
  queueLength = 0,
  queuedRunIds = [],
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  events: AgentEvent[];
  running: boolean;
  queueLength?: number;
  queuedRunIds?: string[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const queuedSet = useMemo(() => new Set(queuedRunIds), [queuedRunIds]);
  const rows = useMemo(
    () =>
      buildRows(events).map((row) =>
        row.type === "user_message"
          ? { ...row, queued: queuedSet.has(row.runId) }
          : row,
      ),
    [events, queuedSet],
  );
  const items = useMemo(() => groupConsecutiveRows(rows), [rows]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  const stickToBottomRef = useRef(true);
  const [autoFold, setAutoFold] = useState(() => loadAutoFold());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );

  const setAutoFoldPersist = (on: boolean): void => {
    setAutoFold(on);
    storeAutoFold(on);
    if (!on) setExpanded({});
  };

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleGroup = (key: string): void => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
  }, [items, running, autoFold, expanded, expandedGroups]);

  return (
    <div className="timeline-wrap">
      <label className="timeline-toolbar">
        <input
          type="checkbox"
          checked={autoFold}
          onChange={(e) => setAutoFoldPersist(e.target.checked)}
        />
        <span>自动折叠执行细节</span>
      </label>
      <div className="timeline" ref={scrollerRef}>
        {hasMore && (
          <button
            type="button"
            className="load-more-btn"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load earlier events"}
          </button>
        )}
        {items.map((item) => {
          if (item.kind === "group") {
            return (
              <EventGroup
                key={item.key}
                groupKey={item.key}
                rows={item.rows}
                expanded={Boolean(expandedGroups[item.key])}
                onToggleGroup={() => toggleGroup(item.key)}
                autoFold={autoFold}
                expandedItems={expanded}
                onToggleItem={toggleExpanded}
              />
            );
          }
          const r = item.row;
          const foldable = r.role === "activity";
          const collapsed = Boolean(autoFold && foldable && !expanded[r.key]);
          return (
            <EventCard
              key={r.key}
              row={r}
              collapsed={collapsed}
              onToggle={
                foldable && autoFold ? () => toggleExpanded(r.key) : undefined
              }
            />
          );
        })}
        <RunningBanner running={running} queueLength={queueLength} />
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
