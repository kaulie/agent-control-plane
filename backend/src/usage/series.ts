import type {
  TokenUsageSeries,
  UsageBucket,
  UsageGranularity,
  UsageRunSample,
  UsageStatsRow,
  UsageTimeZone,
} from "../types.js";
import { tokenVolume } from "./tokens.js";

export interface SeriesFilter {
  granularity: UsageGranularity;
  /** Bucket calendar in local wall-clock or UTC. Default: local. */
  timeZone?: UsageTimeZone;
  /**
   * ISO range. Bucket starts are floored to the granularity; points outside
   * the range are excluded. Omit either bound to span the available data.
   */
  from?: string;
  to?: string;
}

const GRANULARITIES: UsageGranularity[] = ["hour", "day", "week"];
const TIME_ZONES: UsageTimeZone[] = ["local", "utc"];

/** Calendar accessors for local or UTC bucketing. */
interface TzCalendar {
  mode: UsageTimeZone;
  y(d: Date): number;
  mo(d: Date): number;
  day(d: Date): number;
  h(d: Date): number;
  /** Day of week: 0=Sunday … 6=Saturday. */
  dow(d: Date): number;
  /** Construct a Date at y-mo-day h:00:00 in this zone. `mo` is 0-based. */
  at(y: number, mo: number, day: number, h?: number): Date;
}

function localCal(): TzCalendar {
  return {
    mode: "local",
    y: (d) => d.getFullYear(),
    mo: (d) => d.getMonth(),
    day: (d) => d.getDate(),
    h: (d) => d.getHours(),
    dow: (d) => d.getDay(),
    at: (y, mo, day, h = 0) => new Date(y, mo, day, h, 0, 0, 0),
  };
}

function utcCal(): TzCalendar {
  return {
    mode: "utc",
    y: (d) => d.getUTCFullYear(),
    mo: (d) => d.getUTCMonth(),
    day: (d) => d.getUTCDate(),
    h: (d) => d.getUTCHours(),
    dow: (d) => d.getUTCDay(),
    at: (y, mo, day, h = 0) => new Date(Date.UTC(y, mo, day, h, 0, 0, 0)),
  };
}

function calendarFor(tz: UsageTimeZone): TzCalendar {
  return tz === "utc" ? utcCal() : localCal();
}

function floorBucket(d: Date, granularity: UsageGranularity, cal: TzCalendar): Date {
  const y = cal.y(d);
  const mo = cal.mo(d);
  const day = cal.day(d);
  const h = cal.h(d);
  if (granularity === "hour") return cal.at(y, mo, day, h);
  if (granularity === "day") return cal.at(y, mo, day, 0);
  // week starts on Monday 00:00 in the selected zone
  const daysSinceMonday = (cal.dow(d) + 6) % 7;
  return cal.at(y, mo, day - daysSinceMonday, 0);
}

/** Advance one bucket using calendar arithmetic (DST-safe for local). */
function addBucket(d: Date, granularity: UsageGranularity, cal: TzCalendar): Date {
  const y = cal.y(d);
  const mo = cal.mo(d);
  const day = cal.day(d);
  const h = cal.h(d);
  if (granularity === "hour") return cal.at(y, mo, day, h + 1);
  if (granularity === "day") return cal.at(y, mo, day + 1, 0);
  return cal.at(y, mo, day + 7, 0);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Zone wall-clock "YYYY-MM-DDTHH:mm:00" (no offset suffix; see series.timeZone). */
function fmtStart(d: Date, cal: TzCalendar): string {
  return (
    `${cal.y(d)}-${pad2(cal.mo(d) + 1)}-${pad2(cal.day(d))}` +
    `T${pad2(cal.h(d))}:00:00`
  );
}

function makeBucket(
  d: Date,
  granularity: UsageGranularity,
  cal: TzCalendar,
): UsageBucket {
  const start = fmtStart(d, cal);
  const y = cal.y(d);
  const mo = pad2(cal.mo(d) + 1);
  const day = pad2(cal.day(d));
  const h = pad2(cal.h(d));
  const zoneHint = cal.mode === "utc" ? " UTC" : "";
  if (granularity === "hour") {
    return {
      start,
      label: `${mo}-${day} ${h}:00`,
      title: `${y}-${mo}-${day} ${h}:00${zoneHint}`,
    };
  }
  if (granularity === "day") {
    return {
      start,
      label: `${mo}-${day}`,
      title: `${y}-${mo}-${day}${zoneHint}`,
    };
  }
  const end = addBucket(d, "week", cal);
  const endLabel = `${pad2(cal.mo(end) + 1)}-${pad2(cal.day(end))}`;
  return {
    start,
    label: `${mo}-${day}周`,
    title: `${y}-${mo}-${day}（周一） ~ ${cal.y(end)}-${endLabel}（下周一）${zoneHint}`,
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

export function isUsageTimeZone(value: string | undefined): value is UsageTimeZone {
  return TIME_ZONES.includes(value as UsageTimeZone);
}

export function buildTokenUsageSeries(
  samples: UsageRunSample[],
  filter: SeriesFilter,
): TokenUsageSeries {
  const granularity = filter.granularity;
  const timeZone: UsageTimeZone = filter.timeZone === "utc" ? "utc" : "local";
  const cal = calendarFor(timeZone);

  // Attribute each run's token usage to its completion time (fall back to start).
  // Recompute volume with the provider's mode so historical totalTokens
  // (which mixed Cursor/Cline conventions) still match each dashboard.
  const points = samples
    .map((s) => {
      const t = new Date(s.completedAt ?? s.createdAt).getTime();
      const tokens = tokenVolume(s.usage, s.provider);
      return {
        t,
        provider: s.provider,
        model: s.model,
        tokens,
        inputTokens: Number(s.usage?.inputTokens) || 0,
        outputTokens: Number(s.usage?.outputTokens) || 0,
        cacheReadTokens: Number(s.usage?.cacheReadTokens) || 0,
        cacheWriteTokens: Number(s.usage?.cacheWriteTokens) || 0,
      };
    })
    .filter((p) => Number.isFinite(p.t));

  const empty: TokenUsageSeries = {
    granularity,
    timeZone,
    from: "",
    to: "",
    buckets: [],
    rows: [],
    bucketTotalTokens: [],
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
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
    cal,
  ).getTime();
  const lastStart = floorBucket(
    new Date(toBoundary ?? maxT),
    granularity,
    cal,
  ).getTime();
  const first = Math.min(firstStart, lastStart);
  const last = Math.max(firstStart, lastStart);

  // Build a continuous bucket list over [first, last].
  const buckets: UsageBucket[] = [];
  const bucketDates: Date[] = [];
  const startToIndex = new Map<string, number>();
  for (
    let cur = new Date(first);
    cur.getTime() <= last;
    cur = addBucket(cur, granularity, cal)
  ) {
    const key = fmtStart(cur, cal);
    startToIndex.set(key, buckets.length);
    bucketDates.push(cur);
    buckets.push(makeBucket(cur, granularity, cal));
  }
  if (!buckets.length) return empty;

  const endTime = addBucket(
    bucketDates[bucketDates.length - 1]!,
    granularity,
    cal,
  ).getTime();

  // Aggregate per provider/model, dropping points outside the bucket range.
  const map = new Map<
    string,
    { provider: string; model?: string; series: number[] }
  >();
  const bucketTotals = new Array<number>(buckets.length).fill(0);
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let runCount = 0;
  for (const p of points) {
    if (p.t < first || p.t >= endTime) continue;
    const key = fmtStart(floorBucket(new Date(p.t), granularity, cal), cal);
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
    inputTokens += p.inputTokens;
    outputTokens += p.outputTokens;
    cacheReadTokens += p.cacheReadTokens;
    cacheWriteTokens += p.cacheWriteTokens;
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
    const key = fmtStart(floorBucket(new Date(p.t), granularity, cal), cal);
    if (!startToIndex.has(key)) continue;
    const row = rowByKey.get(`${p.provider}\u0000${p.model ?? ""}`);
    if (row) row.runCount += 1;
  }

  const lastBucketDate = bucketDates[bucketDates.length - 1]!;
  return {
    granularity,
    timeZone,
    from: buckets.length ? buckets[0]!.start : "",
    to: fmtStart(addBucket(lastBucketDate, granularity, cal), cal),
    buckets,
    rows,
    bucketTotalTokens: bucketTotals,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    runCount,
  };
}
