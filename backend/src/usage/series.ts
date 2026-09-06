import type {
  TokenUsageSeries,
  UsageBucket,
  UsageGranularity,
  UsageRunSample,
  UsageStatsRow,
} from "../types.js";
import { tokenVolume } from "./tokens.js";

export interface SeriesFilter {
  granularity: UsageGranularity;
  /**
   * ISO range. Bucket starts are floored to the granularity; points outside
   * the range are excluded. Omit either bound to span the available data.
   */
  from?: string;
  to?: string;
}

const GRANULARITIES: UsageGranularity[] = ["hour", "day", "week"];

function floorBucket(d: Date, granularity: UsageGranularity): Date {
  const y = d.getFullYear();
  const mo = d.getMonth();
  const day = d.getDate();
  const h = d.getHours();
  if (granularity === "hour") return new Date(y, mo, day, h, 0, 0, 0);
  if (granularity === "day") return new Date(y, mo, day, 0, 0, 0, 0);
  // week starts on Monday 00:00 (local time)
  const daysSinceMonday = (d.getDay() + 6) % 7;
  return new Date(y, mo, day - daysSinceMonday, 0, 0, 0, 0);
}

/** Advance one bucket using calendar arithmetic (DST-safe). */
function addBucket(d: Date, granularity: UsageGranularity): Date {
  const y = d.getFullYear();
  const mo = d.getMonth();
  const day = d.getDate();
  const h = d.getHours();
  if (granularity === "hour") return new Date(y, mo, day, h + 1, 0, 0, 0);
  if (granularity === "day") return new Date(y, mo, day + 1, 0, 0, 0, 0);
  return new Date(y, mo, day + 7, 0, 0, 0, 0);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local wall-clock "YYYY-MM-DDTHH:mm:00" (used as bucket identity too). */
function fmtStart(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:00:00`
  );
}

function makeBucket(d: Date, granularity: UsageGranularity): UsageBucket {
  const start = fmtStart(d);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const h = pad2(d.getHours());
  if (granularity === "hour") {
    return {
      start,
      label: `${mo}-${day} ${h}:00`,
      title: `${y}-${mo}-${day} ${h}:00`,
    };
  }
  if (granularity === "day") {
    return {
      start,
      label: `${mo}-${day}`,
      title: `${y}-${mo}-${day}`,
    };
  }
  const end = new Date(y, d.getMonth(), d.getDate() + 7, 0, 0, 0, 0);
  const endLabel = `${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`;
  return {
    start,
    label: `${mo}-${day}周`,
    title: `${y}-${mo}-${day}（周一） ~ ${end.getFullYear()}-${endLabel}（下周一）`,
  };
}

function parseBoundary(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : undefined;
}

export function isUsageGranularity(value: string | undefined): value is UsageGranularity {
  return GRANULARITIES.includes(value as UsageGranularity);
}

export function buildTokenUsageSeries(
  samples: UsageRunSample[],
  filter: SeriesFilter,
): TokenUsageSeries {
  const granularity = filter.granularity;

  // Attribute each run's token usage to its completion time (fall back to start).
  // Recompute volume from input+output so historical rows that double-counted
  // cache into totalTokens still match provider dashboards.
  const points = samples
    .map((s) => {
      const t = new Date(s.completedAt ?? s.createdAt).getTime();
      const tokens = tokenVolume(s.usage);
      return { t, provider: s.provider, model: s.model, tokens };
    })
    .filter((p) => Number.isFinite(p.t));

  const empty: TokenUsageSeries = {
    granularity,
    from: "",
    to: "",
    buckets: [],
    rows: [],
    bucketTotalTokens: [],
    totalTokens: 0,
    runCount: 0,
  };
  if (!points.length) return empty;

  const minT = Math.min(...points.map((p) => p.t));
  const maxT = Math.max(...points.map((p) => p.t));
  const fromBoundary = parseBoundary(filter.from);
  const toBoundary = parseBoundary(filter.to);
  const firstStart = floorBucket(
    new Date(fromBoundary ?? minT),
    granularity,
  ).getTime();
  const lastStart = floorBucket(new Date(toBoundary ?? maxT), granularity).getTime();
  const first = Math.min(firstStart, lastStart);
  const last = Math.max(firstStart, lastStart);

  // Build a continuous bucket list over [first, last].
  const buckets: UsageBucket[] = [];
  const startToIndex = new Map<string, number>();
  for (
    let cur = new Date(first);
    cur.getTime() <= last;
    cur = addBucket(cur, granularity)
  ) {
    const key = fmtStart(cur);
    startToIndex.set(key, buckets.length);
    buckets.push(makeBucket(cur, granularity));
  }
  if (!buckets.length) return empty;

  const endTime = addBucket(
    new Date(buckets[buckets.length - 1].start),
    granularity,
  ).getTime();

  // Aggregate per provider/model, dropping points outside the bucket range.
  const map = new Map<
    string,
    { provider: string; model?: string; series: number[] }
  >();
  const bucketTotals = new Array<number>(buckets.length).fill(0);
  let totalTokens = 0;
  let runCount = 0;
  for (const p of points) {
    if (p.t < first || p.t >= endTime) continue;
    const key = fmtStart(floorBucket(new Date(p.t), granularity));
    const idx = startToIndex.get(key);
    if (idx === undefined) continue;
    const groupKey = `${p.provider}\u0000${p.model ?? ""}`;
    let group = map.get(groupKey);
    if (!group) {
      group = {
        provider: p.provider,
        ...(p.model ? { model: p.model } : {}),
        series: new Array<number>(buckets.length).fill(0),
      };
      map.set(groupKey, group);
    }
    group.series[idx] += p.tokens;
    bucketTotals[idx] += p.tokens;
    totalTokens += p.tokens;
    runCount += 1;
  }

  const rows: UsageStatsRow[] = [...map.values()]
    .map((g) => {
      const modelLabel = g.model || "（自动）";
      return {
        provider: g.provider,
        ...(g.model ? { model: g.model } : {}),
        label: `${g.provider} / ${modelLabel}`,
        runCount: 0,
        totalTokens: g.series.reduce((a, b) => a + b, 0),
        series: g.series,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));

  // Per-row run counts (single scan keeps them consistent with bucket totals).
  const rowByKey = new Map(rows.map((r) => [`${r.provider}\u0000${r.model ?? ""}`, r]));
  for (const p of points) {
    if (p.t < first || p.t >= endTime) continue;
    const key = fmtStart(floorBucket(new Date(p.t), granularity));
    if (!startToIndex.has(key)) continue;
    const row = rowByKey.get(`${p.provider}\u0000${p.model ?? ""}`);
    if (row) row.runCount += 1;
  }

  return {
    granularity,
    from: buckets.length ? buckets[0].start : "",
    to: fmtStart(addBucket(new Date(buckets[buckets.length - 1].start), granularity)),
    buckets,
    rows,
    bucketTotalTokens: bucketTotals,
    totalTokens,
    runCount,
  };
}


