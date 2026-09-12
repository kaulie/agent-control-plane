import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AgentRuntimeStatus, ConcurrencySample } from "../types";

interface Props {
  onBack: () => void;
}

const AUTO_KEY = "agent-runtime-auto-refresh";
const INTERVAL_KEY = "agent-runtime-refresh-ms";
const WINDOW_KEY = "agent-runtime-window-ms";

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 5_000, label: "5 秒" },
  { ms: 15_000, label: "15 秒" },
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
];

const WINDOW_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 15 * 60_000, label: "15 分钟" },
  { ms: 30 * 60_000, label: "30 分钟" },
  { ms: 60 * 60_000, label: "1 小时" },
  { ms: 3 * 60 * 60_000, label: "3 小时" },
];

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

function readWindowMs(): number {
  try {
    const n = Number(localStorage.getItem(WINDOW_KEY));
    if (WINDOW_OPTIONS.some((o) => o.ms === n)) return n;
  } catch {
    /* ignore */
  }
  return 30 * 60_000;
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

function clipSeriesToWindow(
  series: ConcurrencySample[],
  windowMs: number,
  nowMs: number,
): ConcurrencySample[] {
  const cutoff = nowMs - windowMs;
  return series.filter((s) => {
    const t = Date.parse(s.t);
    return Number.isFinite(t) && t >= cutoff && t <= nowMs;
  });
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

export function AgentRuntimePage({ onBack }: Props) {
  const [data, setData] = useState<AgentRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(readAutoRefresh);
  const [intervalMs, setIntervalMs] = useState(readIntervalMs);
  const [windowMs, setWindowMs] = useState(readWindowMs);
  /** Chart time domain end; advanced on fetch / window change so X axis tracks 时间轴. */
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
      localStorage.setItem(WINDOW_KEY, String(windowMs));
    } catch {
      /* ignore */
    }
  }, [windowMs]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = (): void => {
      api
        .getAgentRuntime({ windowMs })
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

    // Remap X domain immediately when 时间轴 changes (don't wait for fetch).
    setChartNowMs(Date.now());
    load();
    if (autoRefresh) {
      timer = setInterval(load, intervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [autoRefresh, intervalMs, windowMs]);

  const series = useMemo(
    () => clipSeriesToWindow(data?.series ?? [], windowMs, chartNowMs),
    [data?.series, windowMs, chartNowMs],
  );

  const maxY = useMemo(() => {
    const cap = data?.maxConcurrentRuns ?? 1;
    const peak = Math.max(0, ...series.map((s) => s.runningCount));
    return Math.max(cap, peak, 1);
  }, [data?.maxConcurrentRuns, series]);

  const windowStartMs = chartNowMs - windowMs;
  const windowEndMs = chartNowMs;

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
  const windowLabel =
    WINDOW_OPTIONS.find((o) => o.ms === windowMs)?.label ?? "30 分钟";
  const subtitle = autoRefresh
    ? `全局并发 · 自动刷新 ${intervalLabel}`
    : "全局并发 · 自动刷新已关闭";

  const { width, height, padL, padR, padT, padB } = CHART;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const maxLineY = padT + innerH - (Math.min(data?.maxConcurrentRuns ?? 0, maxY) / maxY) * innerH;
  const axisStart = new Date(windowStartMs).toISOString();
  const axisEnd = new Date(windowEndMs).toISOString();

  const refreshNow = (): void => {
    setLoading(true);
    api
      .getAgentRuntime({ windowMs })
      .then((res) => {
        setData(res);
        setChartNowMs(Date.now());
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
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
        <label className={`stats-filter runtime-refresh-interval${autoRefresh ? "" : " is-disabled"}`}>
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
            value={windowMs}
            onChange={(e) => setWindowMs(Number(e.target.value))}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="runtime-refresh-now" onClick={refreshNow}>
          立即刷新
        </button>
      </div>

      <p className="stats-note">
        展示 gateway 进程内的实时并发（runningCount）与上限（AGENT_MAX_CONCURRENT_RUNS）。
        曲线来自进程内存采样，重启后清空；可用来确认其他任务是否占满全局槽位。
        {data?.admissionPaused
          ? " 当前处于部署 drain：正在运行的 agent 会跑完，排队任务暂不启动。"
          : ""}
      </p>

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
            <div className="stats-card">
              <div className="stats-card-label">排队中</div>
              <div className="stats-card-value">{data.queuedCount}</div>
            </div>
            <div className="stats-card">
              <div className="stats-card-label">活跃任务</div>
              <div className="stats-card-value">{data.activeRuns.length}</div>
            </div>
          </div>

          <div className="runtime-chart-wrap">
            <div className="runtime-chart-label">
              并发执行数量（最近 {windowLabel}）
            </div>
            <svg
              key={windowMs}
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
                    <text x={padL - 8} y={y + 4} textAnchor="end" className="runtime-chart-axis">
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
                <polyline points={points} className="runtime-chart-line" fill="none" />
              )}
              <text x={padL} y={height - 10} className="runtime-chart-axis">
                {formatClock(axisStart)}
              </text>
              <text
                x={padL + innerW}
                y={height - 10}
                textAnchor="end"
                className="runtime-chart-axis"
              >
                {formatClock(axisEnd)}
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
              <span className="runtime-legend-cap">上限 {data.maxConcurrentRuns}</span>
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
