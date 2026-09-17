import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { formatDateTime, formatDuration, formatTime } from "../format";
import { buildStateLine, TIMELINE_LINE_ORDER } from "../timeline-line";
import type {
  AgentActivityState,
  AgentBoardRow,
  AgentTimeline,
  AgentTimelineMarker,
} from "../types";

interface Props {
  /** 从 Agent 看板点进来时预先选中的 agent。 */
  defaultAgentId?: string | null;
  /** 打开某个 task（切到该 task 的对话页）。 */
  onOpenTask: (taskId: string, projectId: string) => void;
  onBack: () => void;
}

const AGENT_KEY = "agent-timeline-agent";
/**
 * 时间范围的落盘 key 带版本：v1 时代这里是「挂载即落盘」，等于用户什么都没选也
 * 被记成一个固定窗口，于是切到活跃时间在窗口外的 agent 就只剩一条全 idle 的灰带。
 * 换 key 让那些隐式记下来的值失效，默认回到「跟着 agent 最近活跃时间走」。
 */
const RANGE_KEY = "agent-timeline-range-v2";
const CUSTOM_FROM_KEY = "agent-timeline-custom-from";
const CUSTOM_TO_KEY = "agent-timeline-custom-to";
const AUTO_KEY = "agent-timeline-auto-refresh";
const INTERVAL_KEY = "agent-timeline-refresh-ms";

interface RangeOption {
  key: string;
  label: string;
  /** 回看窗口；undefined = 自定义。 */
  ms?: number;
  custom?: boolean;
}

const RANGE_OPTIONS: RangeOption[] = [
  { key: "15m", label: "15 分钟", ms: 15 * 60_000 },
  { key: "30m", label: "30 分钟", ms: 30 * 60_000 },
  { key: "1h", label: "1 小时", ms: 60 * 60_000 },
  { key: "3h", label: "3 小时", ms: 3 * 60 * 60_000 },
  { key: "24h", label: "24 小时", ms: 24 * 60 * 60_000 },
  { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60_000 },
  { key: "30d", label: "30 天", ms: 30 * 24 * 60 * 60_000 },
  { key: "custom", label: "自定义", custom: true },
];

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
  { ms: 300_000, label: "5 分钟" },
];

const DAY_MS = 24 * 60 * 60_000;
/** 自定义区间跨度上限（后端同样夹到 30 天）。 */
const MAX_CUSTOM_SPAN_MS = 30 * DAY_MS;

const STATE_LABEL: Record<AgentActivityState, string> = {
  thinking: "thinking",
  working: "working",
  idle: "idle",
};

const STATE_DESC: Record<AgentActivityState, string> = {
  thinking: "模型侧事件：thinking / agent_response / usage / status / run_started",
  working: "工具侧事件：工具调用 / 读文件 / 改文件 / 终端 / 搜索",
  idle: "没有事件：等待用户、排队、run 之间，或超过阈值没有任何事件",
};

/**
 * 左侧纵轴上的短注解：轴上只放得下几个字，所以取 3 个字；完整口径在 `STATE_DESC`
 * （tooltip）和下面的图例里。
 */
const STATE_AXIS_HINT: Record<AgentActivityState, string> = {
  thinking: "模型侧",
  working: "工具侧",
  idle: "无事件",
};

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  finished: "已完成",
  error: "出错",
  cancelled: "已取消",
};

const MARKER_LABEL: Record<string, string> = {
  user_input: "用户输入",
  run_start: "run 开始",
  run_end: "run 结束",
  succession: "agent 替换",
  stall: "疑似停滞",
};

/**
 * 时间线图的布局常量（导出是为了让渲染检查能直接断言几何，见
 * `web/scripts/test-timeline-render.mjs`）。
 *
 * 整张图刻意做得**很扁**：三条状态线每档只差 12（原来是 20，加起来 24 高）；
 * 左边留出 `padL` 写纵轴标签（三条线的名字 + 含义），右边 6。
 */
export const TIMELINE_CHART = {
  width: 1000,
  height: 104,
  /** 左侧纵轴标签（thinking / working / idle 的含义）占的宽度。 */
  padL: 96,
  padR: 6,
  /**
   * 状态线三档高度：thinking 最高、working 中间、idle 最低。
   * 每档只差 12（原来是 20）—— 三条线挨得近，纵轴上的标签也刚好不打架
   * （标签 10px 的墨高约 10.1，留 2 的空隙）。
   */
  levels: { thinking: 9, working: 21, idle: 33 },
  runY: 42,
  runH: 9,
  inputY: 56,
  inputH: 8,
  axisY: 82,
};

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const v = readStored(key);
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  return fallback;
}

function readIntervalMs(): number {
  const n = Number(readStored(INTERVAL_KEY));
  return INTERVAL_OPTIONS.some((o) => o.ms === n) ? n : 60_000;
}

function readRangeKey(): string {
  const v = readStored(RANGE_KEY);
  return RANGE_OPTIONS.some((o) => o.key === v) ? v : "1h";
}

/** 还没有手动选过范围（localStorage 里没有合法值）→ 允许按活跃时间自适应。 */
function readAutoFit(): boolean {
  const v = readStored(RANGE_KEY);
  return !RANGE_OPTIONS.some((o) => o.key === v);
}

/**
 * 首次进入（还没手动选过范围）时按 agent 最近一次活跃时间挑一个合适的窗口，
 * 免得默认 1 小时里什么都没有、页面看起来是空的。
 */
function fitRangeKey(lastActiveAt: string | undefined): string | null {
  if (!lastActiveAt) return null;
  const at = Date.parse(lastActiveAt);
  if (!Number.isFinite(at)) return null;
  const age = Date.now() - at;
  if (age <= 60 * 60_000) return "1h";
  if (age <= 24 * 3600_000) return "24h";
  if (age <= 7 * DAY_MS) return "7d";
  return "30d";
}

/**
 * 窗口里一条事件都没有（后端会补一段覆盖整窗的 idle，所以「有段」不等于「有数据」）。
 * 这种时候画出来的是「全空闲 + 全 0」，必须告诉用户是窗口选错了，而不是这个 agent 在闲。
 */
function isEmptyWindow(data: AgentTimeline): boolean {
  return (
    Object.keys(data.totals.eventCounts ?? {}).length === 0 &&
    data.runs.length === 0 &&
    data.markers.length === 0
  );
}

/** 某个时间点是否落在这次查询的窗口内。 */
function windowCovers(data: AgentTimeline, iso: string | undefined): boolean {
  if (!iso) return true; // 不知道就不提示
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return true;
  return at >= Date.parse(data.from) && at <= Date.parse(data.to);
}

/**
 * 以 agent 最近一次活跃时间为终点的一段窗口（往前 24 小时，往后留 5 分钟，
 * 并夹到「现在」）：窗口里什么都没有时用它自动放宽 / 做「查看那段时间」跳转。
 */
function activityWindow(lastActiveAt: string): { from: string; to: string } | null {
  const at = Date.parse(lastActiveAt);
  if (!Number.isFinite(at)) return null;
  const to = Math.min(at + 5 * 60_000, Date.now());
  const from = Math.max(0, to - 24 * 60 * 60_000);
  if (to - from < 60_000) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** `datetime-local` ↔ ISO（本地时区）。 */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatAxisTick(iso: string, spanMs: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (spanMs > 3 * DAY_MS) return md;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return spanMs > 6 * 60 * 60_000 ? `${md} ${hm}` : hm;
}

function customBounds(fromLocal: string, toLocal: string): {
  fromMin?: string;
  fromMax?: string;
  toMin?: string;
  toMax?: string;
} {
  const fromIso = localInputToIso(fromLocal);
  const toIso = localInputToIso(toLocal);
  const fromMs = fromIso ? Date.parse(fromIso) : NaN;
  const toMs = toIso ? Date.parse(toIso) : NaN;
  return {
    ...(Number.isFinite(toMs)
      ? {
          fromMax: isoToLocalInput(new Date(toMs).toISOString()),
          fromMin: isoToLocalInput(new Date(toMs - MAX_CUSTOM_SPAN_MS).toISOString()),
        }
      : {}),
    ...(Number.isFinite(fromMs)
      ? {
          toMin: isoToLocalInput(new Date(fromMs).toISOString()),
          toMax: isoToLocalInput(new Date(fromMs + MAX_CUSTOM_SPAN_MS).toISOString()),
        }
      : {}),
  };
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

/**
 * 状态线（三条互不相连的水平点线：上 thinking / 中 working / 下 idle，含义写在左侧纵轴上）
 * + run 区间 + 用户输入 marker + 时间轴。
 *
 * 导出是为了能直接把这段 SVG 渲染出来检查（见 `web/scripts/test-timeline-render.mjs`）。
 */
export function TimelineBand({
  data,
  onHover,
}: {
  data: AgentTimeline;
  onHover: (text: string | null) => void;
}) {
  const fromMs = Date.parse(data.from);
  const toMs = Date.parse(data.to);
  const spanMs = Math.max(1, toMs - fromMs);
  const innerW = TIMELINE_CHART.width - TIMELINE_CHART.padL - TIMELINE_CHART.padR;
  const x = (t: number): number =>
    TIMELINE_CHART.padL + ((Math.min(Math.max(t, fromMs), toMs) - fromMs) / spanMs) * innerW;
  const tips = Array.from({ length: 7 }, (_, i) => fromMs + (spanMs * i) / 6);

  /**
   * 这一段 / 这一桶 → 点线的一段 + hover 文案。段模式和桶模式共用后面的点线绘制：
   * 桶模式用桶的 `dominant`（占比最高的状态）作为高度，明细留在 tooltip 里。
   */
  const steps = useMemo(() => {
    const toX = (iso: string): number => x(Date.parse(iso));
    if (data.mode === "segments") {
      return data.segments.map((s) => {
        const title =
          `${STATE_LABEL[s.state]} · ${formatDuration(s.durationMs)}\n` +
          `${formatDateTime(s.start)} → ${formatTime(s.end)}\n` +
          `${STATE_DESC[s.state]}` +
          (s.lastEvent ? `\n最后事件：${s.lastEvent}` : "") +
          (s.runId ? `\nrun ${s.runId}` : "") +
          (s.stalled ? "\n（疑似停滞：超过阈值没有新事件，之后按空闲计）" : "");
        const x0 = toX(s.start);
        return {
          state: s.state,
          x0,
          x1: Math.max(x0 + 0.7, toX(s.end)),
          stalled: Boolean(s.stalled),
          title,
          hover: `${formatDateTime(s.start)} ${title.replace(/\n/g, " · ")}`,
        };
      });
    }
    return data.buckets.map((b) => {
      const title =
        `${formatDateTime(b.start)} → ${formatTime(b.end)}\n` +
        `这一桶主要状态：${STATE_LABEL[b.dominant]}\n` +
        `thinking ${formatDuration(b.thinkingMs)} · working ${formatDuration(
          b.workingMs,
        )} · idle ${formatDuration(b.idleMs)}\n` +
        `run 开始 ${b.runCount} 次 · 用户输入 ${b.userInputs} 次`;
      const x0 = toX(b.start);
      return {
        state: b.dominant,
        x0,
        x1: Math.max(x0 + 0.7, toX(b.end)),
        stalled: false,
        title,
        hover: `${formatDateTime(b.start)} 时间桶 · ${title.replace(/\n/g, " · ")}`,
      };
    });
    // x() 只依赖 from/to，data 变了才会重算。
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const shape = useMemo(() => buildStateLine(steps, TIMELINE_CHART.levels), [steps]);

  return (
    <svg
      className="timeline-chart"
      viewBox={`0 0 ${TIMELINE_CHART.width} ${TIMELINE_CHART.height}`}
      role="img"
      aria-label="agent 状态时间线"
      onMouseLeave={() => onHover(null)}
    >
      {/* 背景网格 + 时间刻度 */}
      {tips.map((t) => (
        <g key={t}>
          <line
            className="timeline-chart-grid"
            x1={x(t)}
            x2={x(t)}
            y1={TIMELINE_CHART.levels.thinking}
            y2={TIMELINE_CHART.axisY - 4}
          />
          <text
            className="timeline-chart-axis"
            x={x(t)}
            y={TIMELINE_CHART.axisY + 12}
            textAnchor={t === fromMs ? "start" : t === toMs ? "end" : "middle"}
          >
            {formatAxisTick(new Date(t).toISOString(), spanMs)}
          </text>
        </g>
      ))}

      {/*
        左侧纵轴：把三条横线的含义写在轴上（颜色跟线一致），
        不用再靠下面的图例去猜哪个高度是什么。
      */}
      {TIMELINE_LINE_ORDER.map((state) => (
        <text
          key={`label-${state}`}
          className={`timeline-axis-label ${state}`}
          x={TIMELINE_CHART.padL - 8}
          y={TIMELINE_CHART.levels[state] + 3.3}
          textAnchor="end"
        >
          {`${STATE_LABEL[state]} ${STATE_AXIS_HINT[state]}`}
        </text>
      ))}

      {/* 三条状态线各自的基准高度：细虚线，和点线区分开（方便看出这一段在哪一档） */}
      {TIMELINE_LINE_ORDER.map((state) => (
        <line
          key={`guide-${state}`}
          className={`timeline-guide ${state}`}
          x1={TIMELINE_CHART.padL}
          x2={TIMELINE_CHART.width - TIMELINE_CHART.padR}
          y1={TIMELINE_CHART.levels[state]}
          y2={TIMELINE_CHART.levels[state]}
        />
      ))}

      {/*
        状态线：三条**互不相连**的水平点线（点状 = CSS 里的 dasharray + round linecap）。
        状态变化处**不画竖直跳线** —— x 就是时间、高度就是状态。
      */}
      {shape.paths.map((p) => (
        <path key={p.state} className={`timeline-line ${p.state}`} d={p.d} />
      ))}

      {/* 疑似停滞（长时间没有新事件）的那几段：同一高度上叠一根细虚线 */}
      {shape.stalled.map((s, i) => (
        <line
          key={`stall-${s.state}-${i}`}
          className="timeline-line-stall"
          x1={s.x0}
          x2={s.x1}
          y1={s.y}
          y2={s.y}
        />
      ))}

      {/* 命中区：三条点线是各自独立的 path，逐段的 hover / tooltip 还得靠透明矩形 */}
      {steps.map((s, i) => (
        <rect
          key={`hit-${i}-${s.x0}`}
          className="timeline-hit"
          x={s.x0}
          y={TIMELINE_CHART.levels.thinking - 6}
          width={Math.max(0.7, s.x1 - s.x0)}
          height={TIMELINE_CHART.levels.idle - TIMELINE_CHART.levels.thinking + 12}
          onMouseEnter={() => onHover(s.hover)}
        >
          <title>{s.title}</title>
        </rect>
      ))}

      {/* run 区间：每条 run 一个条，颜色按最终状态 */}
      {data.runs.map((r) => {
        const sx = x(Date.parse(r.startedAt));
        const ex = x(Date.parse(r.completedAt ?? data.to));
        const title =
          `${RUN_STATUS_LABEL[r.status] ?? r.status} · ${formatDuration(r.durationMs)}\n` +
          `${formatDateTime(r.startedAt)} → ${r.completedAt ? formatTime(r.completedAt) : "（仍在进行）"}\n` +
          `thinking ${formatDuration(r.thinkingMs)} · working ${formatDuration(r.workingMs)}\n` +
          `工具调用 ${r.toolCalls} · 模型调用 ${r.modelCalls}` +
          (r.mode ? `\n模式 ${r.mode}` : "") +
          (r.inputText ? `\n触发输入：${truncate(r.inputText, 120)}` : "");
        return (
          <rect
            key={r.runId}
            className={`timeline-run ${r.status}`}
            x={sx}
            y={TIMELINE_CHART.runY}
            width={Math.max(0.7, ex - sx)}
            height={TIMELINE_CHART.runH}
            rx={2}
            onMouseEnter={() =>
              onHover(
                `${formatDateTime(r.startedAt)} run ${RUN_STATUS_LABEL[r.status] ?? r.status} · ${formatDuration(r.durationMs)}`,
              )
            }
          >
            <title>{title}</title>
          </rect>
        );
      })}

      {/* 用户输入 / 疑似停滞 marker */}
      {data.markers.map((m, i) => {
        if (m.kind !== "user_input" && m.kind !== "stall") return null;
        const mx = x(Date.parse(m.at));
        const isInput = m.kind === "user_input";
        const title =
          `${MARKER_LABEL[m.kind]} · ${formatDateTime(m.at)}` +
          (m.mode ? `\n模式 ${m.mode}` : "") +
          (m.imageCount ? `\n图片 ${m.imageCount} 张` : "") +
          (m.text ? `\n${m.text}` : "") +
          (m.runId ? `\nrun ${m.runId}` : "");
        return (
          <g
            key={`${m.kind}-${m.at}-${i}`}
            onMouseEnter={() =>
              onHover(`${formatDateTime(m.at)} · ${title.replace(/\n/g, " ")}`)
            }
          >
            <polygon
              className={isInput ? "timeline-marker-input" : "timeline-marker-stall"}
              points={
                isInput
                  ? `${mx},${TIMELINE_CHART.inputY} ${mx - 4},${TIMELINE_CHART.inputY + 8} ${mx + 4},${TIMELINE_CHART.inputY + 8}`
                  : `${mx},${TIMELINE_CHART.inputY + 8} ${mx - 4},${TIMELINE_CHART.inputY} ${mx + 4},${TIMELINE_CHART.inputY}`
              }
            />
            {isInput ? (
              <line
                className="timeline-marker-input-line"
                x1={mx}
                x2={mx}
                y1={TIMELINE_CHART.levels.idle}
                y2={TIMELINE_CHART.inputY}
              />
            ) : (
              <line
                className="timeline-marker-stall-line"
                x1={mx}
                x2={mx}
                y1={TIMELINE_CHART.levels.thinking}
                y2={TIMELINE_CHART.inputY}
              />
            )}
            <title>{title}</title>
          </g>
        );
      })}
    </svg>
  );
}



export default function AgentTimelinePage({
  defaultAgentId,
  onOpenTask,
  onBack,
}: Props) {
  const [agents, setAgents] = useState<AgentBoardRow[] | null>(null);
  const [agentId, setAgentId] = useState<string>(
    () => defaultAgentId?.trim() || readStored(AGENT_KEY),
  );
  const [rangeKey, setRangeKey] = useState<string>(() => readRangeKey());
  /** 首次进入 / 还没手动选过范围：按 agent 活跃时间自动挑窗口。 */
  const [autoFit, setAutoFit] = useState(() => readAutoFit());
  const [customFrom, setCustomFrom] = useState(() => readStored(CUSTOM_FROM_KEY));
  const [customTo, setCustomTo] = useState(() => readStored(CUSTOM_TO_KEY));
  const [auto, setAuto] = useState(() => readBool(AUTO_KEY, true));
  const [intervalMs, setIntervalMs] = useState(() => readIntervalMs());
  /** 自动放宽过窗口的 agent 最近活跃时间（用于页面上一句说明）。 */
  const [widened, setWidened] = useState<string | null>(null);
  const [data, setData] = useState<AgentTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /** 防止已经过期的响应覆盖新选择。 */
  const reqRef = useRef(0);

  useEffect(() => {
    if (defaultAgentId?.trim()) setAgentId(defaultAgentId.trim());
  }, [defaultAgentId]);

  // 一次拉全量 agent（含被 succession 替换掉的），供下拉选择。
  useEffect(() => {
    let cancelled = false;
    api
      .getAgentBoard({ scope: "all" })
      .then((board) => {
        if (cancelled) return;
        setAgents(board.rows);
        setAgentId((prev) =>
          prev && board.rows.some((r) => r.agentId === prev)
            ? prev
            : (board.rows[0]?.agentId ?? ""),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (agentId) store(AGENT_KEY, agentId);
    // 换了 agent：上一轮的「自动放宽窗口」说明不再适用。
    setWidened(null);
  }, [agentId]);
  // 时间范围**只在用户明确选过之后**才落盘：默认（自适应）状态下每次都跟着 agent
  // 的最近活跃时间走。以前这里是「挂载即落盘」，于是第二次进页面就变成了固定窗口
  // ——切到一个活跃时间在窗口外的 agent，页面就只有一条全 idle 的灰带和一堆 0。

  /**
   * 自适应窗口（用户还没手动选过范围时）：
   * 1) 刚切到某个 agent：挑一个能包住它「最近活跃时间」的预设窗口；
   * 2) 预设窗口（最长 30 天）也包不住、或者查出来这个窗口里一条事件都没有：
   *    按「最近活跃那一段」自定义一个窗口。
   * 原则：页面不能把「窗口选错了」显示成「这个 agent 很闲」。
   */
  const widenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoFit || !agentId) return;
    const row = agents?.find((a) => a.agentId === agentId);
    const forThisAgent = data?.agentId === agentId;
    const lastActiveAt =
      row?.lastActiveAt ?? (forThisAgent ? data?.lastActiveAt : undefined);
    if (!lastActiveAt || !Number.isFinite(Date.parse(lastActiveAt))) return;

    if (!forThisAgent || !data) {
      // 还在等这个 agent 的第一次结果：先把预设窗口对准它的活跃时间。
      // （已经放宽成自定义窗口时不动它，否则会「放宽 → 又被预设改回去」。）
      const key = fitRangeKey(lastActiveAt);
      if (key && key !== rangeKey && rangeKey !== "custom") setRangeKey(key);
      return;
    }
    if (!isEmptyWindow(data)) return; // 有数据：窗口是好的
    if (windowCovers(data, lastActiveAt)) return; // 没数据，但窗口本来就盖住活跃时间
    const mark = `${agentId}|${data.from}|${data.to}`;
    if (widenedRef.current.has(mark)) return; // 这个窗口已经放宽过一次，别反复切
    widenedRef.current.add(mark);
    const w = activityWindow(lastActiveAt);
    if (!w) return;
    setWidened(lastActiveAt);
    setCustomFrom(isoToLocalInput(w.from));
    setCustomTo(isoToLocalInput(w.to));
    setRangeKey("custom");
  }, [autoFit, agentId, agents, data, rangeKey]);

  useEffect(() => {
    // 换了 agent / 时间范围：先把上一份结果清掉，避免"新标题 + 旧色带"的错觉。
    // （自动刷新不属于这里，它不改变 from/to 的语义。）
    setData(null);
  }, [agentId, rangeKey, customFrom, customTo]);

  const pickRange = useCallback((key: string): void => {
    setAutoFit(false);
    store(RANGE_KEY, key);
    setWidened(null);
    if (key === "custom") setRangeKey("custom");
    else setRangeKey(key);
  }, []);
  useEffect(() => {
    store(CUSTOM_FROM_KEY, customFrom);
  }, [customFrom]);
  useEffect(() => {
    store(CUSTOM_TO_KEY, customTo);
  }, [customTo]);
  useEffect(() => {
    store(AUTO_KEY, auto ? "1" : "0");
  }, [auto]);
  useEffect(() => {
    store(INTERVAL_KEY, String(intervalMs));
  }, [intervalMs]);

  const rangeOpt =
    RANGE_OPTIONS.find((o) => o.key === rangeKey) ?? RANGE_OPTIONS[2];

  /** 生成一次查询（预设窗口 = 最近 N；自定义 = 本地时间转 ISO）。 */
  const buildQuery = useCallback((): { from?: string; to?: string } | { error: string } => {
    if (!rangeOpt.custom) {
      const now = Date.now();
      return {
        from: new Date(now - (rangeOpt.ms ?? 0)).toISOString(),
        to: new Date(now).toISOString(),
      };
    }
    const fromIso = localInputToIso(customFrom);
    const toIso = localInputToIso(customTo);
    if (!fromIso || !toIso) return { error: "请选择自定义时间范围的起止时间" };
    const span = Date.parse(toIso) - Date.parse(fromIso);
    if (span <= 0) return { error: "自定义范围的结束时间必须晚于开始时间" };
    if (span > MAX_CUSTOM_SPAN_MS) return { error: "自定义范围最多 30 天" };
    return { from: fromIso, to: toIso };
  }, [customFrom, customTo, rangeOpt]);

  const load = useCallback(async (): Promise<void> => {
    if (!agentId) return;
    const q = buildQuery();
    if ("error" in q) {
      setError(q.error);
      return;
    }
    const reqId = ++reqRef.current;
    setLoading(true);
    try {
      const res = await api.getAgentTimeline(agentId, q);
      if (reqRef.current !== reqId) return;
      setData(res);
      setError(null);
    } catch (e) {
      if (reqRef.current !== reqId) return;
      setError(errorText(e));
      setData(null);
    } finally {
      if (reqRef.current === reqId) setLoading(false);
    }
  }, [agentId, buildQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => void load(), intervalMs);
    return () => window.clearInterval(id);
  }, [auto, intervalMs, load]);

  const onPickCustom = (): void => {
    pickRange("custom");
    if (!customFrom || !customTo) {
      const end = new Date();
      setCustomFrom(isoToLocalInput(new Date(end.getTime() - 60 * 60_000).toISOString()));
      setCustomTo(isoToLocalInput(end.toISOString()));
    }
  };

  /** 「查看那段时间」：把窗口挪到该 agent 最近活跃的那一段（显式选择，会被记住）。 */
  const jumpToActivity = useCallback((lastActiveAt: string): void => {
    const w = activityWindow(lastActiveAt);
    if (!w) return;
    setAutoFit(false);
    store(RANGE_KEY, "custom");
    setWidened(null);
    setCustomFrom(isoToLocalInput(w.from));
    setCustomTo(isoToLocalInput(w.to));
    setRangeKey("custom");
  }, []);

  const selected = useMemo(
    () => agents?.find((a) => a.agentId === agentId),
    [agents, agentId],
  );

  /**
   * 这个窗口里一条事件都没有 —— 要么窗口选错了（活跃时间在窗口外），要么这个 agent
   * 本来就没跑过。两种情况都得说出来，不能让页面静悄悄地显示一堆 0。
   */
  const emptyHint = useMemo(() => {
    if (!data || !isEmptyWindow(data)) return null;
    const lastActiveAt = data.lastActiveAt ?? selected?.lastActiveAt;
    const covered = windowCovers(data, lastActiveAt);
    return {
      lastActiveAt,
      outside: Boolean(lastActiveAt) && !covered,
    };
  }, [data, selected]);

  /** 下拉里按 project 分组，标签带上 task 与最后活跃时间。 */
  const grouped = useMemo(() => {
    const map = new Map<string, AgentBoardRow[]>();
    for (const a of agents ?? []) {
      const list = map.get(a.projectName) ?? [];
      list.push(a);
      map.set(a.projectName, list);
    }
    return [...map.entries()];
  }, [agents]);

  const eventChips = useMemo(() => {
    const entries = Object.entries(data?.totals.eventCounts ?? {});
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, 8);
  }, [data]);

  const inputs = useMemo(
    () => (data?.markers ?? []).filter((m) => m.kind === "user_input"),
    [data],
  );

  const rangeCaption = useMemo(() => {
    if (!data) return "";
    return `${formatDateTime(data.from)} → ${formatDateTime(data.to)}（${
      data.mode === "buckets"
        ? `按 ${data.buckets.length} 个时间桶聚合`
        : `${data.segments.length} 个状态段`
    }）`;
  }, [data]);

  const openTask = (): void => {
    if (data) onOpenTask(data.taskId, data.projectId);
  };

  const markerTitle = (m: AgentTimelineMarker): string =>
    m.kind === "user_input"
      ? (m.text ?? "（无文本，可能是图片或 Plan 回答）")
      : (m.label ?? MARKER_LABEL[m.kind] ?? m.kind);


  return (
    <main className="stats-page timeline-page">
      <div className="stats-head">
        <div className="stats-head-left">
          <button type="button" className="icon-btn" title="返回" onClick={onBack}>
            ←
          </button>
          <h2 className="stats-title">Agent 时间线</h2>
          <span className="stats-subtitle">
            idle / thinking / working · 含用户输入事件
          </span>
        </div>
        <div className="stats-head-right">
          <button
            type="button"
            className="runtime-refresh-now"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      <div className="runtime-refresh-bar" role="group" aria-label="时间线与刷新控制">
        <label className="stats-filter stats-filter-grow">
          <span>Agent</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            title="一个 agent = 绑定在 task 上的一个 SDK 会话"
          >
            {(agents ?? []).length === 0 && <option value="">（暂无 agent）</option>}
            {grouped.map(([projectName, list]) => (
              <optgroup key={projectName} label={projectName}>
                {list.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.agentName} · {a.taskTitle || a.taskId.slice(-6)}
                    {a.supersededAt ? "（已替换）" : a.current ? "（当前）" : ""} ·{" "}
                    {relativeTime(a.lastActiveAt)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="stats-filter">
          <span>时间范围{autoFit ? "（自动）" : ""}</span>
          <select
            value={rangeKey}
            title={
              autoFit
                ? "自动：跟着该 agent 的最近活跃时间走（手动选一次之后固定下来）"
                : "手动选择的时间范围（清空 localStorage 后恢复自动）"
            }
            onChange={(e) => {
              const next = e.target.value;
              if (next === "custom") onPickCustom();
              else pickRange(next);
            }}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {rangeOpt.custom && (
          <>
            <label className="stats-filter runtime-custom-range">
              <span>从</span>
              <input
                type="datetime-local"
                value={customFrom}
                min={customBounds(customFrom, customTo).fromMin}
                max={customBounds(customFrom, customTo).fromMax}
                title="自定义区间跨度上限 30 天"
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="stats-filter runtime-custom-range">
              <span>到</span>
              <input
                type="datetime-local"
                value={customTo}
                min={customBounds(customFrom, customTo).toMin}
                max={customBounds(customFrom, customTo).toMax}
                title="自定义区间跨度上限 30 天"
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </>
        )}
        <label className="runtime-refresh-toggle">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          <span>自动刷新</span>
        </label>
        <label
          className={`stats-filter runtime-refresh-interval${auto ? "" : " is-disabled"}`}
        >
          <span>刷新周期</span>
          <select
            value={intervalMs}
            disabled={!auto}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>


      {data && (
        <div className="timeline-agent-bar">
          <span className="timeline-agent-name" title={data.agentId}>
            {data.agentName}
          </span>
          <span className="runtime-active-sep">·</span>
          <button
            type="button"
            className="board-task-link"
            title={`打开这个 task（${data.taskId}）`}
            onClick={openTask}
          >
            {data.taskTitle || `#${data.taskId.slice(-6)}`}
          </button>
          <span className="runtime-active-sep">·</span>
          <span className="board-cell-dept" title="所属部门">
            {data.department?.departmentName ?? "（未设置部门）"}
          </span>
          <span className="runtime-active-sep">·</span>
          <span title="provider / model">
            {data.provider}
            {data.model ? ` / ${data.model}` : "（默认模型）"}
          </span>
          {!data.current && (
            <>
              <span className="runtime-active-sep">·</span>
              <span className="board-badge replaced">已被 succession 替换</span>
            </>
          )}
          {selected?.running && <span className="board-badge running">正在运行</span>}
          {data.lastActiveAt && (
            <span className="board-badge" title={data.lastActiveAt}>
              最近活跃 {relativeTime(data.lastActiveAt)}
            </span>
          )}
        </div>
      )}

      <p className="stats-note">{data?.note ?? "按事件判定 agent 的工作状态（idle / thinking / working）。"}</p>

      {widened && (
        <div className="timeline-hint">
          <span>
            时间范围是自动的：这个 agent 最近活跃在 {formatDateTime(widened)}（
            {relativeTime(widened)}），窗口已放宽到包含那一段。
          </span>
        </div>
      )}

      {emptyHint && !widened && (
        <div className="timeline-hint">
          <span>
            这个时间范围里没有该 agent 的事件。
            {emptyHint.lastActiveAt
              ? emptyHint.outside
                ? `它最近活跃在 ${formatDateTime(emptyHint.lastActiveAt)}（${relativeTime(
                    emptyHint.lastActiveAt,
                  )}），不在这个窗口里。`
                : `它的最近活跃时间是 ${formatDateTime(
                    emptyHint.lastActiveAt,
                  )}，但窗口内没有落任何事件（可能还没真正跑过）。`
              : ""}
          </span>
          {emptyHint.outside && emptyHint.lastActiveAt && (
            <button
              type="button"
              className="runtime-refresh-now"
              onClick={() => jumpToActivity(emptyHint.lastActiveAt as string)}
            >
              查看那段时间
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="stats-error" onClick={() => setError(null)}>
          {error} ✕
        </div>
      )}

      <div className="stats-summary">
        <div className="stats-card">
          <div className="stats-card-label">活跃占比</div>
          <div className="stats-card-value">
            {data ? `${Math.round(data.totals.activeRatio * 100)}%` : "—"}
          </div>
          <div className="stats-card-caption">
            活跃 {data ? formatDuration(data.totals.activeMs) : "—"} / 共{" "}
            {data ? formatDuration(data.totals.spanMs) : "—"}
          </div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">thinking</div>
          <div className="stats-card-value stats-card-value-sm">
            {data ? formatDuration(data.totals.thinkingMs) : "—"}
          </div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">working</div>
          <div className="stats-card-value stats-card-value-sm">
            {data ? formatDuration(data.totals.workingMs) : "—"}
          </div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">idle</div>
          <div className="stats-card-value stats-card-value-sm">
            {data ? formatDuration(data.totals.idleMs) : "—"}
          </div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">用户输入</div>
          <div className="stats-card-value">{data?.totals.userInputCount ?? 0}</div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">run 轮次（本窗口）</div>
          <div className="stats-card-value">{data?.totals.runCount ?? 0}</div>
          {data && (
            <div
              className="stats-card-caption"
              title="「run 轮次」只统计当前窗口内的 run；累计是这个 agent 自己的全部 run（不含 task 里被 succession 换掉的其他 agent）"
            >
              该 agent 累计 {data.agentCompletedRounds} 轮 / {data.agentRunCount} runs
            </div>
          )}
        </div>
        <div className="stats-card">
          <div className="stats-card-label">工具 / 模型调用</div>
          <div className="stats-card-value stats-card-value-sm">
            {data ? `${data.totals.toolCalls} / ${data.totals.modelCalls}` : "—"}
          </div>
        </div>
        <div className="stats-card stats-card-wide">
          <div className="stats-card-label">时间轴</div>
          <div className="stats-card-caption">{rangeCaption || "—"}</div>
        </div>
      </div>


      <div className="timeline-chart-wrap">
        {loading && !data ? (
          <div className="stats-loading">正在读取事件…</div>
        ) : !data || (!data.segments.length && !data.buckets.length) ? (
          <div className="stats-empty">
            这个时间范围内没有该 agent 的记录（可能选到了还没有活动的窗口）。
          </div>
        ) : (
          <TimelineBand data={data} onHover={setHover} />
        )}
        <div className="timeline-hover" aria-live="polite">
          {hover ??
            "悬停点线 / run 条 / 三角标记可看这一段的起止、时长与判定依据；点 task 名可跳回该对话。"}
        </div>
        <div className="timeline-legend">
          <span className="timeline-legend-item timeline-legend-note">
            点线 = 状态，含义见左侧纵轴（上 thinking 模型侧 · 中 working 工具侧 · 下 idle 无事件）；三条线之间不画连接线
          </span>
          <span className="timeline-legend-item">
            <i className="timeline-swatch state thinking" />
            thinking（模型侧事件）
          </span>
          <span className="timeline-legend-item">
            <i className="timeline-swatch state working" />
            working（工具侧事件）
          </span>
          <span className="timeline-legend-item">
            <i className="timeline-swatch state idle" />
            idle（无事件）
          </span>
          <span className="timeline-legend-item">
            <i className="timeline-swatch run" />
            run 区间
          </span>
          <span className="timeline-legend-item">
            <i className="timeline-swatch input" />
            用户输入
          </span>
          <span className="timeline-legend-item">
            <i className="timeline-swatch stall" />
            疑似停滞（超过阈值无事件）
          </span>
        </div>
        {eventChips.length > 0 && (
          <div className="timeline-event-chips">
            <span className="stats-card-label">窗口内事件</span>
            {eventChips.map(([type, count]) => (
              <span key={type} className="timeline-chip" title={`${type} × ${count}`}>
                {type} <b>{count}</b>
              </span>
            ))}
          </div>
        )}
      </div>


      {inputs.length > 0 && (
        <>
          <div className="timeline-section-title">
            用户输入事件
            <span className="runtime-section-count">
              区间内 {inputs.length} 次（点击内容跳回该 task）
            </span>
          </div>
          <div className="stats-scroll">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模式</th>
                  <th>内容</th>
                  <th>所属 run</th>
                </tr>
              </thead>
              <tbody>
                {inputs.map((m, i) => (
                  <tr key={`${m.at}-${i}`}>
                    <td className="timeline-cell-time">{formatDateTime(m.at)}</td>
                    <td className="timeline-cell-mode">
                      <span className={`event-mode${m.mode === "plan" ? " event-mode-plan" : ""}`}>
                        {m.mode ?? "agent"}
                      </span>
                    </td>
                    <td className="timeline-cell-input">
                      <button
                        type="button"
                        className="board-task-link timeline-input-link"
                        title={markerTitle(m)}
                        onClick={openTask}
                      >
                        {truncate(markerTitle(m), 90)}
                      </button>
                      {m.imageCount ? (
                        <span className="board-task-id">图片 {m.imageCount} 张</span>
                      ) : null}
                    </td>
                    <td className="timeline-cell-run" title={m.runId ?? ""}>
                      {m.runId ? m.runId.slice(-8) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {(data?.runs.length ?? 0) > 0 && (
        <>
          <div className="timeline-section-title">
            Run 明细
            <span className="runtime-section-count">区间内 {data?.runs.length} 轮</span>
          </div>
          <div className="stats-scroll">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>开始</th>
                  <th>时长</th>
                  <th>状态</th>
                  <th>thinking</th>
                  <th>working</th>
                  <th className="timeline-cell-num">工具调用</th>
                  <th className="timeline-cell-num">模型调用</th>
                  <th>模型</th>
                  <th>触发输入</th>
                </tr>
              </thead>
              <tbody>
                {data?.runs.map((r) => (
                  <tr key={r.runId}>
                    <td
                      className="timeline-cell-time"
                      title={`${formatDateTime(r.startedAt)}${
                        r.completedAt ? ` → ${formatDateTime(r.completedAt)}` : "（仍在进行）"
                      }\nrun ${r.runId}`}
                    >
                      {formatDateTime(r.startedAt)}
                    </td>
                    <td>{formatDuration(r.durationMs)}</td>
                    <td>
                      <span className={`board-status ${r.status === "error" ? "error" : r.status === "finished" ? "" : "active"}`}>
                        {RUN_STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td>{formatDuration(r.thinkingMs)}</td>
                    <td>{formatDuration(r.workingMs)}</td>
                    <td className="timeline-cell-num">{r.toolCalls}</td>
                    <td className="timeline-cell-num">{r.modelCalls}</td>
                    <td className="board-cell-model" title={r.model ?? "（provider 默认）"}>
                      {r.model ?? `（${data.provider} 默认）`}
                    </td>
                    <td className="timeline-cell-input">
                      {r.inputText ? (
                        <button
                          type="button"
                          className="board-task-link timeline-input-link"
                          title={r.inputText}
                          onClick={openTask}
                        >
                          {truncate(r.inputText, 60)}
                        </button>
                      ) : (
                        <span className="board-task-id">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data && data.markers.length > 0 && (
        <div className="timeline-section-title timeline-other-markers">
          其他标记：
          {data.markers
            .filter((m) => m.kind !== "user_input")
            .map((m, i) => (
              <span key={`${m.kind}-${m.at}-${i}`} className={`timeline-chip ${m.kind}`} title={m.label ?? m.kind}>
                {MARKER_LABEL[m.kind] ?? m.kind} {formatTime(m.at)}
              </span>
            ))}
        </div>
      )}
    </main>
  );
}

