import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  Project,
  TokenUsageSeries,
  UsageGranularity,
} from "../types";

interface Props {
  defaultProjectId?: string | null;
  onBack: () => void;
}

interface RangeOption {
  key: string;
  label: string;
  /** Look-back window; undefined = all history. */
  ms?: number;
}

const GRANULARITY_LABEL: Record<UsageGranularity, string> = {
  hour: "小时",
  day: "天",
  week: "周",
};

const GRANULARITY_OPTIONS: UsageGranularity[] = ["day", "hour", "week"];

const RANGES: Record<UsageGranularity, RangeOption[]> = {
  hour: [
    { key: "24h", label: "最近24小时", ms: 24 * 3600_000 },
    { key: "3d", label: "最近3天", ms: 3 * 86400_000 },
    { key: "all", label: "全部" },
  ],
  day: [
    { key: "7d", label: "最近7天", ms: 7 * 86400_000 },
    { key: "30d", label: "最近30天", ms: 30 * 86400_000 },
    { key: "90d", label: "最近90天", ms: 90 * 86400_000 },
    { key: "all", label: "全部" },
  ],
  week: [
    { key: "4w", label: "最近4周", ms: 28 * 86400_000 },
    { key: "12w", label: "最近12周", ms: 84 * 86400_000 },
    { key: "all", label: "全部" },
  ],
};

function defaultRange(granularity: UsageGranularity): string {
  return granularity === "hour" ? "24h" : granularity === "day" ? "30d" : "12w";
}

function fmtTok(n: number | undefined | null): string {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US");
}

/** Heat color for a non-zero cell relative to its column max. */
function heat(v: number, max: number):
  | { backgroundColor: string; color: string }
  | undefined {
  if (!v || !max) return undefined;
  const t = Math.min(1, v / max);
  const alpha = 0.12 + 0.62 * t;
  return {
    backgroundColor: `rgba(76, 141, 255, ${alpha.toFixed(3)})`,
    color: t > 0.55 ? "#fff" : "inherit",
  };
}

export default function UsageStatsPage({ defaultProjectId, onBack }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scope, setScope] = useState<string>("");
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const [rangeKey, setRangeKey] = useState<string>(defaultRange("day"));
  const [data, setData] = useState<TokenUsageSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const initial = defaultProjectId
          ? list.some((p) => p.projectId === defaultProjectId)
            ? defaultProjectId
            : ""
          : "";
        setScope(initial);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [defaultProjectId]);

  const rangeMs = useMemo(() => {
    const option = RANGES[granularity].find((r) => r.key === rangeKey);
    return option?.ms;
  }, [granularity, rangeKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const from = rangeMs === undefined ? undefined : new Date(Date.now() - rangeMs).toISOString();
    api
      .getTokenUsageSeries({
        ...(scope ? { projectId: scope } : {}),
        granularity,
        ...(from ? { from } : {}),
      })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, granularity, rangeMs]);

  const changeGranularity = (next: UsageGranularity): void => {
    setGranularity(next);
    setRangeKey(defaultRange(next));
  };

  const maxPerBucket = useMemo(() => {
    if (!data) return [];
    return data.buckets.map((_, i) =>
      Math.max(0, ...data.rows.map((r) => r.series[i] || 0)),
    );
  }, [data]);

  const rangeCaption = useMemo(() => {
    if (!data || !data.buckets.length) return "";
    const first = data.buckets[0].title;
    const last = data.buckets[data.buckets.length - 1].title;
    return `${first} ~ ${last}（按${GRANULARITY_LABEL[data.granularity]}）`;
  }, [data]);

  return (
    <main className="stats-page">
      <div className="stats-head">
        <div className="stats-head-left">
          <button type="button" className="icon-btn" title="返回" onClick={onBack}>
            ←
          </button>
          <h2 className="stats-title">Token 用量统计</h2>
          <span className="stats-subtitle">
            provider / model 粒度 · 仅统计总 token
          </span>
        </div>
      </div>

      <div className="stats-filters">
        <label className="stats-filter">
          <span>范围</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">全系统</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="stats-filter">
          <span>粒度</span>
          <select
            value={granularity}
            onChange={(e) => changeGranularity(e.target.value as UsageGranularity)}
          >
            {GRANULARITY_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {GRANULARITY_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="stats-filter">
          <span>时间范围</span>
          <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)}>
            {RANGES[granularity].map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stats-summary">
        <div className="stats-card">
          <div className="stats-card-label">总 Token</div>
          <div className="stats-card-value">{fmtTok(data?.totalTokens)}</div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">Agent（provider/model）</div>
          <div className="stats-card-value">{data?.rows.length ?? 0}</div>
        </div>
        <div className="stats-card">
          <div className="stats-card-label">计量的 Run 数</div>
          <div className="stats-card-value">{data?.runCount ?? 0}</div>
        </div>
        <div className="stats-card stats-card-wide">
          <div className="stats-card-label">时间轴</div>
          <div className="stats-card-caption">
            {loading ? "加载中…" : rangeCaption || "暂无数据"}
          </div>
        </div>
      </div>

      {error && (
        <div className="stats-error" onClick={() => setError(null)}>
          {error} ✕
        </div>
      )}

      {loading ? (
        <div className="stats-loading">正在统计 token 消耗量…</div>
      ) : !data || !data.buckets.length ? (
        <div className="stats-empty">
          当前范围内暂无 token 消耗记录（尚未有完成且带计量的 run）。
        </div>
      ) : (
        <div className="stats-scroll">
          <table className="stats-table">
            <thead>
              <tr>
                <th className="stats-head-agent">Agent（provider / model）</th>
                {data.buckets.map((b) => (
                  <th key={b.start} title={b.title}>
                    {b.label}
                  </th>
                ))}
                <th className="stats-head-total">合计</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, ri) => (
                <tr key={`${row.provider} / ${row.model ?? ""}`}>
                  <td className="stats-agent-cell">
                    <div className="stats-agent">{row.label}</div>
                    <div className="stats-agent-sub">{row.runCount} runs</div>
                  </td>
                  {row.series.map((v, i) => (
                    <td
                      key={i}
                      className="stats-num"
                      style={heat(v, maxPerBucket[i])}
                      title={`${fmtTok(v)} tokens`}
                    >
                      {v ? fmtTok(v) : ""}
                    </td>
                  ))}
                  <td className="stats-total-cell stats-num">{fmtTok(row.totalTokens)}</td>
                </tr>
              ))}
              <tr className="stats-total-row">
                <td className="stats-total-row-label">全部 Agent</td>
                {data.bucketTotalTokens.map((v, i) => (
                  <td
                    key={i}
                    className="stats-num"
                    title={`${fmtTok(v)} tokens`}
                  >
                    {v ? fmtTok(v) : ""}
                  </td>
                ))}
                <td className="stats-total-cell stats-num">
                  {fmtTok(data.totalTokens)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
