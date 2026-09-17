/**
 * Agent 时间线：把「事件流」折叠成 idle / thinking / working 状态段。
 *
 * 判定口径（唯一来源，SQL 侧的状态 CASE 也由这里生成，避免两处漂移）：
 *
 * | 状态 | 依据事件 |
 * |---|---|
 * | `thinking` | `run_started` / `thinking` / `agent_response` / `usage` / `status` / `plan_*` / `agent_decision` |
 * | `working` | `tool_call_started` / `tool_result` / `file_read` / `file_edit` / `terminal` / `search` |
 * | `idle` | 其余事件（`user_message` / run 结束·取消·出错 / `agent_succession`），以及任何状态「超过 stallMs 没有新事件」之后的部分 |
 *
 * 为什么要有 stallMs：事件只在 agent 真的动的时候产生，所以一段时间没有任何事件
 * 有两种可能 —— 在长时间跑一个工具，或者卡住/等重启。为了不把「卡住 5 分钟」也算成
 * working，同一状态连续超过 `stallMs` 没有新事件就按 idle 计（并在截断点打一个
 * `stall` marker，前端能看出这段是「疑似停滞」而不是本来就空闲）。
 *
 * 纯函数：输入 store 查出来的行，输出时间线，便于单测。
 */
import type {
  AgentActivityState,
  AgentTimelineBucket,
  AgentTimelineMarker,
  AgentTimelineRun,
  AgentTimelineSegment,
  AgentTimelineTotals,
  EventType,
  RunStatus,
} from "./types.js";

/** 模型侧事件：agent 在生成 / 思考。 */
export const THINKING_EVENT_TYPES: readonly EventType[] = [
  "run_started",
  "thinking",
  "agent_response",
  "usage",
  "status",
  "plan_draft",
  "plan_question_batch",
  "agent_decision",
];

/** 工具侧事件：agent 在动文件 / 跑命令 / 检索。 */
export const WORKING_EVENT_TYPES: readonly EventType[] = [
  "tool_call_started",
  "tool_result",
  "file_read",
  "file_edit",
  "terminal",
  "search",
];

/** 需要单独标在时间线上的瞬时事件（用户输入、run 起止、agent 替换）。 */
export const MARKER_EVENT_TYPES: readonly EventType[] = [
  "user_message",
  "run_started",
  "run_completed",
  "run_error",
  "run_cancelled",
  "agent_succession",
];

/** 同一状态超过这个时长没有新事件 → 之后按 idle 计（见文件头注释）。 */
export const DEFAULT_STALL_MS = 5 * 60_000;

/** 状态段超过这个数量就退化为时间桶（避免一次渲染几万个 <rect>）。 */
export const MAX_SEGMENTS = 2000;

/** 桶模式下的桶数。 */
export const BUCKET_COUNT = 600;

/** 截断后至少要空出这么久才值得打一个 stall marker（否则噪音太大）。 */
const STALL_MARKER_MIN_GAP_MS = 30_000;

export function stateOfEventType(eventType: string): AgentActivityState {
  if ((THINKING_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return "thinking";
  }
  if ((WORKING_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return "working";
  }
  return "idle";
}

function sqlList(types: readonly string[]): string {
  return types.map((t) => `'${t}'`).join(", ");
}

/** `event_type` → 状态的 SQL CASE（口径与 {@link stateOfEventType} 一致）。 */
export function sqlStateCase(column = "event_type"): string {
  return `CASE
    WHEN ${column} IN (${sqlList(THINKING_EVENT_TYPES)}) THEN 'thinking'
    WHEN ${column} IN (${sqlList(WORKING_EVENT_TYPES)}) THEN 'working'
    ELSE 'idle'
  END`;
}

/** marker 事件的 SQL IN 列表。 */
export function sqlMarkerInList(column = "event_type"): string {
  return `${column} IN (${sqlList(MARKER_EVENT_TYPES)})`;
}

export function agentTimelineNote(stallMs: number): string {
  const min = Math.round(stallMs / 60_000);
  return (
    "状态口径（按事件判定）：thinking = 模型侧事件（thinking / agent_response / " +
    "usage / status / run_started / plan*）；working = 工具侧事件（tool_call_started / " +
    "tool_result / file_read / file_edit / terminal / search）；idle = 其余事件" +
    "（用户消息、run 结束/取消/出错、agent 替换），以及「同一状态超过 " +
    `${min} 分钟没有新事件」之后的部分（疑似卡住 / 等待，截断点会打「疑似停滞」标记）。`
  );
}


/**
 * 状态段的关键点：一个状态组的「第一条」和「最后一条」事件。
 * （中间事件的 state 与前后都相同，省略掉也不会改变状态序列。）
 */
export interface TimelineStateRow {
  timestamp: string;
  eventType: string;
  runId: string;
  state: AgentActivityState;
  /** 这个状态组的起点（前一条事件的状态不同 / 是第一条）。 */
  isStart: boolean;
  /** 这个状态组的终点（后一条事件的状态不同 / 是最后一条）。 */
  isEnd: boolean;
}

/** marker 事件的原始行。 */
export interface TimelineMarkerRow {
  timestamp: string;
  eventType: string;
  runId: string;
  payload: Record<string, unknown>;
}

/** 时间线内的一轮 run（store 侧已按时间窗裁剪）。 */
export interface TimelineRunRow {
  runId: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  model?: string;
  modelCalls: number;
  toolCalls: number;
}

export interface AgentTimelineInput {
  fromIso: string;
  toIso: string;
  groups: TimelineStateRow[];
  markers: TimelineMarkerRow[];
  runs: TimelineRunRow[];
  eventCounts: Record<string, number>;
  stallMs?: number;
}

export interface AgentTimelineResult {
  mode: "segments" | "buckets";
  segments: AgentTimelineSegment[];
  buckets: AgentTimelineBucket[];
  markers: AgentTimelineMarker[];
  runs: AgentTimelineRun[];
  totals: AgentTimelineTotals;
}

interface RawSegment {
  state: AgentActivityState;
  startMs: number;
  endMs: number;
  runId?: string;
  lastEvent?: EventType;
  /** 本段被「无事件超过 stallMs」截断（后面接的是空闲）。 */
  stalled?: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 事件 → 状态段。
 *
 * 规则：每个状态组的证据区间是 `[组首事件, 组末事件 + stallMs]`，但
 * - 下一个状态组的首事件会立即覆盖（状态切换以事件为准）；
 * - 窗口两端裁到 [from, to]。
 * 窗口开头、run 之间、最后一轮 run 之后的空洞由 fillIdle 补成 idle。
 */
function foldSegments(
  groups: TimelineStateRow[],
  fromMs: number,
  toMs: number,
  stallMs: number,
): RawSegment[] {
  const ordered = [...groups].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const out: RawSegment[] = [];
  let open: { state: AgentActivityState; startMs: number; runId?: string } | null =
    null;

  for (const row of ordered) {
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at)) continue;
    if (row.isStart) {
      // 正常情况上一个组已被 isEnd 关闭；这里只是防御性兜底。
      if (open) {
        out.push({
          state: open.state,
          startMs: open.startMs,
          endMs: Math.max(open.startMs, at),
          ...(open.runId ? { runId: open.runId } : {}),
        });
      }
      open = {
        state: row.state,
        startMs: Math.max(at, fromMs),
        ...(row.runId ? { runId: row.runId } : {}),
      };
    }
    if (row.isEnd && open) {
      const evidenceEnd = at + stallMs;
      out.push({
        state: open.state,
        startMs: open.startMs,
        endMs: Math.max(open.startMs, Math.min(evidenceEnd, toMs)),
        ...(open.runId ? { runId: open.runId } : {}),
        ...(row.eventType ? { lastEvent: row.eventType as EventType } : {}),
      });
      open = null;
    }
  }
  if (open) {
    out.push({
      state: open.state,
      startMs: open.startMs,
      endMs: toMs,
      ...(open.runId ? { runId: open.runId } : {}),
    });
  }

  // 状态切换覆盖：本段实际结束于「下一个状态的首事件」；证据区间先用完、下一边界
  // 又来得更晚时，这一段就是被 stall 截断的（前端显示「疑似停滞」）。
  // 只有 thinking / working 需要标注 —— idle 本来就是"没在干活"。
  const clamped: RawSegment[] = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const next = out[i + 1];
    const boundary = next ? next.startMs : toMs;
    let endMs = Math.min(cur.endMs, toMs);
    let stalled = false;
    if (boundary < endMs) {
      endMs = boundary;
    } else if (
      cur.state !== "idle" &&
      endMs + STALL_MARKER_MIN_GAP_MS <= boundary
    ) {
      stalled = true;
    }
    if (endMs <= cur.startMs) continue;
    pushSegment(clamped, {
      state: cur.state,
      startMs: cur.startMs,
      endMs,
      ...(cur.runId ? { runId: cur.runId } : {}),
      ...(cur.lastEvent ? { lastEvent: cur.lastEvent } : {}),
      ...(stalled ? { stalled: true } : {}),
    });
  }
  return clamped;
}

/** 相邻同类段合并（同一状态、同一 run 且首尾相接）。 */
function pushSegment(out: RawSegment[], seg: RawSegment): void {
  const last = out[out.length - 1];
  if (
    last &&
    last.state === seg.state &&
    last.runId === seg.runId &&
    last.endMs === seg.startMs
  ) {
    last.endMs = seg.endMs;
    if (!seg.stalled) delete last.stalled;
    if (seg.lastEvent) last.lastEvent = seg.lastEvent;
    return;
  }
  out.push(seg);
}

/** 把状态段之间的空洞（含窗口两端）补成 idle 段。 */
function fillIdle(segments: RawSegment[], fromMs: number, toMs: number): RawSegment[] {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  const out: RawSegment[] = [];
  let cursor = fromMs;
  for (const seg of ordered) {
    // idle 段不挂 runId：run 结束后的空闲与"下一轮之前"的空闲是同一种东西，
    // 不挂 runId 才能自然合并成一段（run 边界另有 run_start/run_end marker）。
    const clean: RawSegment =
      seg.state === "idle" ? { state: seg.state, startMs: seg.startMs, endMs: seg.endMs } : seg;
    if (clean.startMs > cursor) {
      pushSegment(out, { state: "idle", startMs: cursor, endMs: clean.startMs });
    }
    pushSegment(out, clean);
    cursor = Math.max(cursor, clean.endMs);
  }
  if (cursor < toMs) pushSegment(out, { state: "idle", startMs: cursor, endMs: toMs });
  return out;
}

/** 状态段 → 等宽时间桶（跨度大时用，前端画堆叠柱）。 */
export function bucketSegments(
  segments: RawSegment[],
  fromMs: number,
  toMs: number,
  markers: AgentTimelineMarker[],
  count = BUCKET_COUNT,
): AgentTimelineBucket[] {
  const span = toMs - fromMs;
  if (span <= 0 || segments.length === 0) return [];
  const n = Math.max(1, Math.min(count, Math.ceil(span / 1000)));
  const width = span / n;
  const buckets: AgentTimelineBucket[] = [];
  for (let i = 0; i < n; i++) {
    const startMs = fromMs + i * width;
    const endMs = i === n - 1 ? toMs : fromMs + (i + 1) * width;
    buckets.push({
      start: iso(Math.round(startMs)),
      end: iso(Math.round(endMs)),
      thinkingMs: 0,
      workingMs: 0,
      idleMs: 0,
      dominant: "idle",
      runCount: 0,
      userInputs: 0,
    });
  }

  // 段与桶都按时间正序，一次线性扫描（一段可能横跨多个桶）。
  let bi = 0;
  for (const seg of segments) {
    while (bi < n && Date.parse(buckets[bi].end) <= seg.startMs) bi += 1;
    for (let j = bi; j < n; j++) {
      const bStart = Date.parse(buckets[j].start);
      const bEnd = Date.parse(buckets[j].end);
      if (bStart >= seg.endMs) break;
      const overlap = Math.min(bEnd, seg.endMs) - Math.max(bStart, seg.startMs);
      if (overlap <= 0) continue;
      if (seg.state === "thinking") buckets[j].thinkingMs += overlap;
      else if (seg.state === "working") buckets[j].workingMs += overlap;
      else buckets[j].idleMs += overlap;
    }
  }

  for (const m of markers) {
    const at = Date.parse(m.at);
    if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((at - fromMs) / width)));
    if (m.kind === "run_start") buckets[idx].runCount += 1;
    else if (m.kind === "user_input") buckets[idx].userInputs += 1;
  }

  for (const b of buckets) {
    const best = Math.max(b.thinkingMs, b.workingMs, b.idleMs);
    b.dominant =
      best <= 0
        ? "idle"
        : b.thinkingMs === best
          ? "thinking"
          : b.workingMs === best
            ? "working"
            : "idle";
  }
  return buckets;
}

/** marker 行 → 时间线 marker（含用户输入原文）。 */
function buildMarkers(
  rows: TimelineMarkerRow[],
  fromMs: number,
  toMs: number,
): { markers: AgentTimelineMarker[]; inputByRun: Map<string, AgentTimelineMarker> } {
  const markers: AgentTimelineMarker[] = [];
  const inputByRun = new Map<string, AgentTimelineMarker>();
  for (const row of rows) {
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
    const payload = row.payload ?? {};
    const runId = row.runId ? { runId: row.runId } : {};
    switch (row.eventType) {
      case "user_message": {
        const text = typeof payload.text === "string" ? payload.text : "";
        const mode =
          payload.mode === "plan" ? "plan" : payload.mode === "agent" ? "agent" : undefined;
        const imageCount = Array.isArray(payload.images) ? payload.images.length : 0;
        const marker: AgentTimelineMarker = {
          at: row.timestamp,
          kind: "user_input",
          label: mode === "plan" ? "用户输入（Plan）" : "用户输入（Agent）",
          ...(text ? { text } : {}),
          ...(mode ? { mode } : {}),
          ...(imageCount ? { imageCount } : {}),
          ...runId,
        };
        markers.push(marker);
        if (row.runId && !inputByRun.has(row.runId)) inputByRun.set(row.runId, marker);
        break;
      }
      case "run_started":
        markers.push({
          at: row.timestamp,
          kind: "run_start",
          label: "run 开始",
          ...runId,
        });
        break;
      case "run_completed":
      case "run_error":
      case "run_cancelled":
        markers.push({
          at: row.timestamp,
          kind: "run_end",
          label:
            row.eventType === "run_completed"
              ? "run 完成"
              : row.eventType === "run_cancelled"
                ? "run 已取消"
                : "run 出错",
          status:
            row.eventType === "run_completed"
              ? "finished"
              : row.eventType === "run_cancelled"
                ? "cancelled"
                : "error",
          ...runId,
        });
        break;
      case "agent_succession": {
        const from = typeof payload.fromAgentId === "string" ? payload.fromAgentId : "?";
        const to = typeof payload.toAgentId === "string" ? payload.toAgentId : "?";
        const reason = typeof payload.reason === "string" ? payload.reason : "";
        markers.push({
          at: row.timestamp,
          kind: "succession",
          label: `agent 会话切换（${reason || "unknown"}）：${from} → ${to}`,
          ...runId,
        });
        break;
      }
      default:
        break;
    }
  }
  return { markers, inputByRun };
}


/**
 * 时间线主入口：状态段 / 时间桶 / markers / runs / totals。
 * `segments` 首尾相接且正好覆盖 [from, to]（span 合法时）。
 */
export function buildAgentTimeline(input: AgentTimelineInput): AgentTimelineResult {
  const fromMs = Date.parse(input.fromIso);
  const toMs = Date.parse(input.toIso);
  const stallMs = Math.max(0, input.stallMs ?? DEFAULT_STALL_MS);
  const valid = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
  const raw = valid ? fillIdle(foldSegments(input.groups, fromMs, toMs, stallMs), fromMs, toMs) : [];

  const segments: AgentTimelineSegment[] = raw.map((s) => ({
    state: s.state,
    start: iso(s.startMs),
    end: iso(s.endMs),
    durationMs: Math.max(0, s.endMs - s.startMs),
    ...(s.runId ? { runId: s.runId } : {}),
    ...(s.lastEvent ? { lastEvent: s.lastEvent } : {}),
    ...(s.stalled ? { stalled: true } : {}),
  }));

  const { markers, inputByRun } = buildMarkers(input.markers, fromMs, toMs);
  for (const s of raw) {
    if (!s.stalled) continue;
    markers.push({
      at: iso(s.endMs),
      kind: "stall",
      label: `疑似停滞：超过 ${Math.round(stallMs / 60_000)} 分钟没有新事件，之后按空闲计`,
      ...(s.runId ? { runId: s.runId } : {}),
    });
  }
  markers.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // ---- runs：窗口内该 agent 的每一轮（thinking / working 用状态段实测）----
  const thinkingByRun = new Map<string, number>();
  const workingByRun = new Map<string, number>();
  for (const s of raw) {
    if (!s.runId || s.state === "idle") continue;
    const target = s.state === "thinking" ? thinkingByRun : workingByRun;
    target.set(s.runId, (target.get(s.runId) ?? 0) + Math.max(0, s.endMs - s.startMs));
  }
  const nowMs = Date.now();
  const runs: AgentTimelineRun[] = input.runs
    .map((r) => {
      const startMs = Date.parse(r.createdAt);
      const endMs = r.completedAt ? Date.parse(r.completedAt) : nowMs;
      return { r, startMs, endMs };
    })
    .filter(
      (x) =>
        Number.isFinite(x.startMs) && x.endMs >= fromMs && x.startMs <= toMs,
    )
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ r, startMs, endMs }) => {
      const seed = inputByRun.get(r.runId);
      return {
        runId: r.runId,
        status: r.status,
        startedAt: r.createdAt,
        ...(r.completedAt ? { completedAt: r.completedAt } : {}),
        durationMs: Math.max(0, r.durationMs ?? endMs - startMs),
        thinkingMs: thinkingByRun.get(r.runId) ?? 0,
        workingMs: workingByRun.get(r.runId) ?? 0,
        modelCalls: r.modelCalls || 0,
        toolCalls: r.toolCalls || 0,
        ...(r.model ? { model: r.model } : {}),
        ...(seed?.text ? { inputText: seed.text } : {}),
        ...(seed?.mode ? { mode: seed.mode } : {}),
      };
    });

  // ---- totals ----
  let thinkingMs = 0;
  let workingMs = 0;
  let idleMs = 0;
  for (const s of raw) {
    const d = Math.max(0, s.endMs - s.startMs);
    if (s.state === "thinking") thinkingMs += d;
    else if (s.state === "working") workingMs += d;
    else idleMs += d;
  }
  const spanMs = valid ? toMs - fromMs : 0;
  const activeMs = thinkingMs + workingMs;
  const totals: AgentTimelineTotals = {
    spanMs,
    thinkingMs,
    workingMs,
    idleMs,
    activeMs,
    activeRatio: spanMs > 0 ? activeMs / spanMs : 0,
    runCount: runs.length,
    userInputCount: markers.filter((m) => m.kind === "user_input").length,
    toolCalls: runs.reduce((sum, r) => sum + r.toolCalls, 0),
    modelCalls: runs.reduce((sum, r) => sum + r.modelCalls, 0),
    eventCounts: input.eventCounts,
  };

  // 段太多就退化成时间桶：前端不画几万个 <rect>，但 totals / runs / markers 不变。
  const mode: "segments" | "buckets" =
    segments.length > MAX_SEGMENTS ? "buckets" : "segments";
  return {
    mode,
    segments: mode === "segments" ? segments : [],
    buckets:
      mode === "buckets" && valid
        ? bucketSegments(raw, fromMs, toMs, markers, BUCKET_COUNT)
        : [],
    markers,
    runs,
    totals,
  };
}

