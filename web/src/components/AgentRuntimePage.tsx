import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  AgentRuntimeStatus,
  ConcurrencyGranularity,
  ConcurrencySample,
} from "../types";

interface Props {
  onBack: () => void;
}

const AUTO_KEY = "agent-runtime-auto-refresh";
const INTERVAL_KEY = "agent-runtime-refresh-ms";
const RANGE_KEY = "agent-runtime-range-key";
const CUSTOM_FROM_KEY = "agent-runtime-custom-from";
const CUSTOM_TO_KEY = "agent-runtime-custom-to";

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 5_000, label: "5 秒" },
  { ms: 15_000, label: "15 秒" },
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
];

interface RangeOption {
  key: string;
  label: string;
  /** Look-back; undefined = all history or custom. */
  ms?: number;
  all?: boolean;
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
  { key: "all", label: "全部", all: true },
  { key: "custom", label: "自定义", custom: true },
];

const GRANULARITY_LABEL: Record<ConcurrencyGranularity, string> = {
  raw: "原始采样",
  minute: "按分钟聚合",
  hour: "按小时聚合",
};

const CHART = {
  width: 720,
  height: 280,
  padL: 40,
  padR: 16,
  padT: 16,
  padB: 36,
};

function readAutoRefresh(): boolean {
  try {
    const v = localStorage.getItem(AUTO_KEY);
    if (v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
  } catch {
    /* ignore */
  }
  return true;
}

function readIntervalMs(): number {
  try {
    const n = Number(localStorage.getItem(INTERVAL_KEY));
    if (INTERVAL_OPTIONS.some((o) => o.ms === n)) return n;
  } catch {
    /* ignore */
  }
  return 5_000;
}

function readRangeKey(): string {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    if (v && RANGE_OPTIONS.some((o) => o.key === v)) return v;
  } catch {
    /* ignore */
  }
  return "30m";
}

function readCustomLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** `datetime-local` value ↔ ISO, using local wall clock. */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
  if (spanMs > 24 * 60 * 60_000) {
    return d.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: spanMs <= 60 * 60_000 ? "2-digit" : undefined,
    hour12: false,
  });
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Slot utilization: running / cap, as percent (0–∞; can exceed 100 if oversubscribed). */
function loadRatePct(running: number, cap: number): number {
  if (!(cap > 0) || !Number.isFinite(running)) return 0;
  return (Math.max(0, running) / cap) * 100;
}

function formatLoadPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  const rounded = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded}%`;
}

/** Map samples onto a fixed time domain so changing 时间轴 re-scales X immediately. */
function buildPolyline(
  series: ConcurrencySample[],
  maxY: number,
  windowStartMs: number,
  windowEndMs: number,
): { points: string; area: string } {
  const { width, height, padL, padR, padT, padB } = CHART;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const span = Math.max(1, windowEndMs - windowStartMs);
  if (series.length === 0) return { points: "", area: "" };

  const coords = series
    .map((s) => {
      const t = Date.parse(s.t);
      if (!Number.isFinite(t)) return null;
      const x = padL + ((t - windowStartMs) / span) * innerW;
      const y = padT + innerH - (Math.min(s.runningCount, maxY) / maxY) * innerH;
      return { x, y };
    })
    .filter((c): c is { x: number; y: number } => c != null);

  if (coords.length === 0) return { points: "", area: "" };

  const points = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const baseY = padT + innerH;
  const area = [
    `${coords[0].x.toFixed(1)},${baseY}`,
    ...coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`),
    `${coords[coords.length - 1].x.toFixed(1)},${baseY}`,
  ].join(" ");
  return { points, area };
}

function buildQuery(
  rangeKey: string,
  customFrom: string,
  customTo: string,
):
  | { windowMs: number }
  | { all: true }
  | { from: string; to: string }
  | null {
  const opt = RANGE_OPTIONS.find((o) => o.key === rangeKey) ?? RANGE_OPTIONS[1];
  if (opt.all) return { all: true };
  if (opt.custom) {
    const from = localInputToIso(customFrom);
    const to = localInputToIso(customTo);
    if (!from || !to) return null;
    return { from, to };
  }
  return { windowMs: opt.ms ?? 30 * 60_000 };
}

export function AgentRuntimePage({ onBack }: Props) {
  const [data, setData] = useState<AgentRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(readAutoRefresh);
  const [intervalMs, setIntervalMs] = useState(readIntervalMs);
  const [rangeKey, setRangeKey] = useState(readRangeKey);
  const [customFrom, setCustomFrom] = useState(() =>
    readCustomLocal(CUSTOM_FROM_KEY),
  );
  const [customTo, setCustomTo] = useState(() => readCustomLocal(CUSTOM_TO_KEY));
  /** Chart time domain; prefer server from/to when present. */
  const [chartNowMs, setChartNowMs] = useState(() => Date.now());

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_KEY, autoRefresh ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [autoRefresh]);

  useEffect(() => {
    try {
      localStorage.setItem(INTERVAL_KEY, String(intervalMs));
    } catch {
      /* ignore */
    }
  }, [intervalMs]);

  useEffect(() => {
    try {
      localStorage.setItem(RANGE_KEY, rangeKey);
    } catch {
      /* ignore */
    }
  }, [rangeKey]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_FROM_KEY, customFrom);
      localStorage.setItem(CUSTOM_TO_KEY, customTo);
    } catch {
      /* ignore */
    }
  }, [customFrom, customTo]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = (): void => {
      const query = buildQuery(rangeKey, customFrom, customTo);
      if (!query) {
        if (!cancelled) {
          setError("请填写有效的自定义起止时间");
          setLoading(false);
        }
        return;
      }
      api
        .getAgentRuntime(query)
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setChartNowMs(Date.now());
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    setChartNowMs(Date.now());
    load();
    if (autoRefresh) {
      timer = setInterval(load, intervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [autoRefresh, intervalMs, rangeKey, customFrom, customTo]);

  const windowStartMs = useMemo(() => {
    if (data?.from) {
      const t = Date.parse(data.from);
      if (Number.isFinite(t)) return t;
    }
    const opt = RANGE_OPTIONS.find((o) => o.key === rangeKey);
    if (opt?.ms) return chartNowMs - opt.ms;
    return chartNowMs - 30 * 60_000;
  }, [data?.from, rangeKey, chartNowMs]);

  const windowEndMs = useMemo(() => {
    if (data?.to) {
      const t = Date.parse(data.to);
      if (Number.isFinite(t)) return t;
    }
    return chartNowMs;
  }, [data?.to, chartNowMs]);

  const spanMs = Math.max(1, windowEndMs - windowStartMs);
  const series = data?.series ?? [];
  const cap = Math.max(0, data?.maxConcurrentRuns ?? 0);
  const currentLoadPct = loadRatePct(data?.runningCount ?? 0, cap);

  const windowLoad = useMemo(() => {
    if (!series.length || !(cap > 0)) {
      return { peakPct: null as number | null, avgPct: null as number | null };
    }
    let peak = 0;
    let sum = 0;
    for (const s of series) {
      const pct = loadRatePct(s.runningCount, cap);
      if (pct > peak) peak = pct;
      sum += pct;
    }
    return { peakPct: peak, avgPct: sum / series.length };
  }, [series, cap]);

  const maxY = useMemo(() => {
    const limit = data?.maxConcurrentRuns ?? 1;
    const peak = Math.max(0, ...series.map((s) => s.runningCount));
    return Math.max(limit, peak, 1);
  }, [data?.maxConcurrentRuns, series]);

  const { points, area } = useMemo(
    () => buildPolyline(series, maxY, windowStartMs, windowEndMs),
    [series, maxY, windowStartMs, windowEndMs],
  );

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let v = 0; v <= maxY; v += 1) ticks.push(v);
    return ticks;
  }, [maxY]);

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.ms === intervalMs)?.label ?? "5 秒";
  const rangeOpt =
    RANGE_OPTIONS.find((o) => o.key === rangeKey) ?? RANGE_OPTIONS[1];
  const granularity = data?.granularity ?? "raw";
  const subtitle = autoRefresh
    ? `全局并发 · 自动刷新 ${intervalLabel} · ${GRANULARITY_LABEL[granularity]}`
    : `全局并发 · 自动刷新已关闭 · ${GRANULARITY_LABEL[granularity]}`;

  const { width, height, padL, padR, padT, padB } = CHART;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const maxLineY =
    padT +
    innerH -
    (Math.min(data?.maxConcurrentRuns ?? 0, maxY) / maxY) * innerH;
  const axisStart = new Date(windowStartMs).toISOString();
  const axisEnd = new Date(windowEndMs).toISOString();

  const refreshNow = (): void => {
    const query = buildQuery(rangeKey, customFrom, customTo);
    if (!query) {
      setError("请填写有效的自定义起止时间");
      return;
    }
    setLoading(true);
    api
      .getAgentRuntime(query)
      .then((res) => {
        setData(res);
        setChartNowMs(Date.now());
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  const onPickCustom = (): void => {
    setRangeKey("custom");
    if (!customFrom || !customTo) {
      const end = new Date();
      const start = new Date(end.getTime() - 60 * 60_000);
      setCustomFrom(isoToLocalInput(start.toISOString()));
      setCustomTo(isoToLocalInput(end.toISOString()));
    }
  };

  return (
    <main className="stats-page">
      <div className="stats-head">
        <div className="stats-head-left">
          <button type="button" className="icon-btn" title="返回" onClick={onBack}>
            ←
          </button>
          <h2 className="stats-title">Agent 运行状态</h2>
          <span className="stats-subtitle">{subtitle}</span>
        </div>
      </div>

      <div className="runtime-refresh-bar" role="group" aria-label="刷新控制">
        <label className="runtime-refresh-toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          <span>自动刷新</span>
        </label>
        <label
          className={`stats-filter runtime-refresh-interval${autoRefresh ? "" : " is-disabled"}`}
        >
          <span>刷新周期</span>
          <select
            value={intervalMs}
            disabled={!autoRefresh}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="stats-filter">
          <span>时间轴</span>
          <select
            value={rangeKey}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "custom") onPickCustom();
              else setRangeKey(next);
            }}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {rangeKey === "custom" ? (
          <>
            <label className="stats-filter runtime-custom-range">
              <span>从</span>
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="stats-filter runtime-custom-range">
              <span>到</span>
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </>
        ) : null}
        <button type="button" className="runtime-refresh-now" onClick={refreshNow}>
          立即刷新
        </button>
      </div>

      <p className="stats-note">
        展示 gateway 实时并发（runningCount）与上限（AGENT_MAX_CONCURRENT_RUNS）。
        满载率 = 当前并发 ÷ 上限。所选时间轴内另给出峰值 / 平均满载率。
        曲线来自 SQLite 全量持久化采样（约每 15 秒一点，永不删除）。
        时间轴超过 1 小时按分钟聚合峰值，超过 24 小时按小时聚合峰值。
      </p>

      {data?.admissionPaused ? (
        <div className="runtime-drain-banner" role="status">
          部署 drain 中：已暂停启动排队任务
          {data.runningCount === 0 && data.queuedCount > 0
            ? `（当前 0 并发但仍有 ${data.queuedCount} 条排队，属预期；约 5 分钟超时或取消 hold 后会自动恢复）`
            : "；在跑的 agent 会跑完"}
          {data.admissionPausedAt
            ? ` · 开始于 ${formatClock(data.admissionPausedAt)}`
            : ""}
        </div>
      ) : null}

      {error && <div className="stats-error">{error}</div>}
      {loading && !data && <div className="stats-empty">加载中…</div>}

      {data && (
        <>
          <div className="stats-summary">
            <div className="stats-card">
              <div className="stats-card-label">当前并发</div>
              <div className="stats-card-value">
                {data.runningCount}
                <span className="runtime-cap"> / {data.maxConcurrentRuns}</span>
              </div>
            </div>
            <div
              className={`stats-card${currentLoadPct >= 100 ? " stats-card-warn" : ""}`}
              title="满载率 = 当前并发 ÷ AGENT_MAX_CONCURRENT_RUNS"
            >
              <div className="stats-card-label">满载率</div>
              <div className="stats-card-value runtime-load-pct">
                {formatLoadPct(currentLoadPct)}
              </div>
              <div className="stats-card-caption">
                {data.runningCount}/{data.maxConcurrentRuns} 槽位
              </div>
            </div>
            <div className="stats-card" title="所选时间轴内采样点的最高满载率">
              <div className="stats-card-label">峰值满载率</div>
              <div className="stats-card-value runtime-load-pct">
                {windowLoad.peakPct == null
                  ? "—"
                  : formatLoadPct(windowLoad.peakPct)}
              </div>
              <div className="stats-card-caption">{rangeOpt.label}</div>
            </div>
            <div className="stats-card" title="所选时间轴内采样点的平均满载率">
              <div className="stats-card-label">平均满载率</div>
              <div className="stats-card-value runtime-load-pct">
                {windowLoad.avgPct == null
                  ? "—"
                  : formatLoadPct(windowLoad.avgPct)}
              </div>
              <div className="stats-card-caption">{rangeOpt.label}</div>
            </div>
            <div className="stats-card">
              <div className="stats-card-label">排队中</div>
              <div className="stats-card-value">{data.queuedCount}</div>
            </div>
            <div
              className={`stats-card${data.admissionPaused ? " stats-card-warn" : ""}`}
            >
              <div className="stats-card-label">准入</div>
              <div className="stats-card-value runtime-admission">
                {data.admissionPaused ? "drain" : "开放"}
              </div>
            </div>
            <div className="stats-card">
              <div className="stats-card-label">活跃任务</div>
              <div className="stats-card-value">{data.activeRuns.length}</div>
            </div>
          </div>

          <div className="runtime-chart-wrap">
            <div className="runtime-chart-label">
              并发执行数量（{rangeOpt.label}
              {granularity !== "raw"
                ? ` · ${GRANULARITY_LABEL[granularity]}`
                : ""}
              ）
            </div>
            <svg
              key={`${rangeKey}-${windowStartMs}-${windowEndMs}`}
              className="runtime-chart"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="并发 agent 数量折线图"
            >
              {yTicks.map((v) => {
                const y = padT + innerH - (v / maxY) * innerH;
                return (
                  <g key={v}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={padL + innerW}
                      y2={y}
                      className="runtime-chart-grid"
                    />
                    <text
                      x={padL - 8}
                      y={y + 4}
                      textAnchor="end"
                      className="runtime-chart-axis"
                    >
                      {v}
                    </text>
                  </g>
                );
              })}
              {data.maxConcurrentRuns > 0 && (
                <line
                  x1={padL}
                  y1={maxLineY}
                  x2={padL + innerW}
                  y2={maxLineY}
                  className="runtime-chart-cap"
                />
              )}
              {area && <polygon points={area} className="runtime-chart-area" />}
              {points && (
                <polyline
                  points={points}
                  className="runtime-chart-line"
                  fill="none"
                />
              )}
              <text x={padL} y={height - 10} className="runtime-chart-axis">
                {formatAxisTick(axisStart, spanMs)}
              </text>
              <text
                x={padL + innerW}
                y={height - 10}
                textAnchor="end"
                className="runtime-chart-axis"
              >
                {formatAxisTick(axisEnd, spanMs)}
              </text>
              {!series.length && (
                <text
                  x={padL + innerW / 2}
                  y={padT + innerH / 2}
                  textAnchor="middle"
                  className="runtime-chart-empty"
                >
                  暂无采样点
                </text>
              )}
            </svg>
            <div className="runtime-chart-legend">
              <span className="runtime-legend-line">并发数</span>
              <span className="runtime-legend-cap">
                上限 {data.maxConcurrentRuns}
              </span>
              <span className="runtime-legend-load">
                当前满载 {formatLoadPct(currentLoadPct)}
                {windowLoad.peakPct != null
                  ? ` · 峰值 ${formatLoadPct(windowLoad.peakPct)}`
                  : ""}
              </span>
            </div>
          </div>

          <div className="runtime-active">
            <div className="runtime-active-title">
              当前占用槽位
              <span className="runtime-section-count">{data.activeRuns.length}</span>
            </div>
            {data.activeRuns.length === 0 ? (
              <div className="runtime-active-empty">暂无运行中的任务</div>
            ) : (
              <ul className="runtime-active-list">
                {data.activeRuns.map((r) => (
                  <li key={r.runId}>
                    <span className="runtime-active-project">
                      {r.projectName?.trim() || r.projectId || "未命名项目"}
                    </span>
                    <span className="runtime-active-sep">·</span>
                    <code>{r.taskId}</code>
                    {r.taskTitle?.trim() ? (
                      <>
                        <span className="runtime-active-sep">·</span>
                        <span className="runtime-active-title-text">
                          {r.taskTitle.trim()}
                        </span>
                      </>
                    ) : null}
                    <span className="runtime-active-sep">·</span>
                    <code>{r.runId}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="runtime-active">
            <div className="runtime-active-title">
              排队中任务
              <span className="runtime-section-count">
                {(data.queuedRuns ?? []).length}
              </span>
            </div>
            {(data.queuedRuns ?? []).length === 0 ? (
              <div className="runtime-active-empty">暂无排队任务</div>
            ) : (
              <ul className="runtime-active-list">
                {(data.queuedRuns ?? []).map((r, i) => (
                  <li key={`${r.runId}-${i}`}>
                    <span className="runtime-queue-pos">#{i + 1}</span>
                    <span className="runtime-active-sep">·</span>
                    <span className="runtime-active-project">
                      {r.projectName?.trim() || r.projectId || "未命名项目"}
                    </span>
                    <span className="runtime-active-sep">·</span>
                    <code>{r.taskId}</code>
                    {r.taskTitle?.trim() ? (
                      <>
                        <span className="runtime-active-sep">·</span>
                        <span className="runtime-active-title-text">
                          {r.taskTitle.trim()}
                        </span>
                      </>
                    ) : null}
                    {r.mode ? (
                      <>
                        <span className="runtime-active-sep">·</span>
                        <span className="runtime-queue-mode">{r.mode}</span>
                      </>
                    ) : null}
                    <span className="runtime-active-sep">·</span>
                    <code>{r.runId}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </main>
  );
}
