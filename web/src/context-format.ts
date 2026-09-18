import type { TaskContextSize } from "./types";
import { formatTokens } from "./format";

/**
 * 上下文徽标的显示口径（纯函数，便于测试）。
 *
 * - **tokens = 当前会话的请求体量**（最近一次模型调用的 prompt），不是 usage 的累加值；
 * - limit 来自 provider 的模型目录（deepseek-v4-* = 1,000,000）；未知就只说 tokens、不给百分比；
 * - cursor 的 usage 是 agent 累计值，推不出体量 → 明确显示「未知 + 原因」，不猜数。
 */

export type ContextTone = "ok" | "warn" | "alert" | "over" | "unknown";

export interface ContextRunBar {
  runId: string;
  /** 该轮增量（tokens），用于柱高。 */
  growth: number;
  /** 0-100，相对最近几轮最大增量。 */
  heightPct: number;
  /** 换了会话（重启 / 轮转）的那一轮。 */
  reset: boolean;
  title: string;
}

export interface ContextView {
  hasData: boolean;
  percentLabel: string;
  tokensLabel: string;
  tone: ContextTone;
  title: string;
  /** 还能跑几轮到告警线（可选）。 */
  runsLeftLabel?: string;
  bars: ContextRunBar[];
}

function toneFor(percent: number | undefined): ContextTone {
  if (percent == null) return "unknown";
  if (percent >= 100) return "over";
  if (percent >= 85) return "alert";
  if (percent >= 70) return "warn";
  return "ok";
}

function percentText(percent: number | undefined): string {
  if (percent == null) return "—";
  return `${percent.toFixed(1)}%`;
}

export function contextView(context?: TaskContextSize): ContextView {
  if (!context) {
    return {
      hasData: false,
      percentLabel: "—",
      tokensLabel: "无数据",
      tone: "unknown",
      title: "还没有可用的上下文采样（这个 task 还没有带 usage 的 run）",
      bars: [],
    };
  }

  if (!context.available) {
    return {
      hasData: false,
      percentLabel: "未知",
      tokensLabel: "—",
      tone: "unknown",
      title: `${context.note ?? "该 provider 不提供单次请求体量"}（不做估算，避免给错数）`,
      bars: [],
    };
  }

  const tokens = context.tokens ?? 0;
  const limit = context.limit;
  const tokensLabel = limit
    ? `${formatTokens(tokens)} / ${formatTokens(limit)}`
    : formatTokens(tokens);

  const maxGrowth = Math.max(1, ...context.runs.map((r) => r.growthTokens));
  const bars: ContextRunBar[] = context.runs.slice(-10).map((r) => ({
    runId: r.runId,
    growth: r.growthTokens,
    heightPct: Math.max(6, Math.round((r.growthTokens / maxGrowth) * 100)),
    reset: r.reset,
    title:
      `${r.runId.slice(-8)} · ${r.at.slice(11, 16)} · ${r.calls} 次调用\n` +
      `${formatTokens(r.startTokens)} → ${formatTokens(r.endTokens)}（${r.growthTokens >= 0 ? "+" : ""}${formatTokens(r.growthTokens)}）` +
      (r.reset ? "\n← 这一轮换了会话（重启 / 轮转）" : ""),
  }));

  const parts: string[] = [
    "当前会话的请求体量（最近一次模型调用的 prompt；不是 usage 累加值）",
  ];
  if (context.model) parts.push(`模型 ${context.model}`);
  parts.push(`上限 ${limit ? formatTokens(limit) : "未知"}`);
  if (context.sampledAt) parts.push(`采样 ${context.sampledAt.slice(11, 19)}`);
  parts.push(`预警线 ${context.thresholds.warn}% / 建议 fork ${context.thresholds.alert}%`);
  if (context.avgGrowthTokens) parts.push(`平均每轮 +${formatTokens(context.avgGrowthTokens)}`);

  return {
    hasData: true,
    percentLabel: percentText(context.percent),
    tokensLabel,
    tone: toneFor(context.percent),
    title: parts.join(" · "),
    ...(context.estimatedRunsLeft != null
      ? { runsLeftLabel: `约 ${context.estimatedRunsLeft} 轮后到 ${context.thresholds.alert}%` }
      : {}),
    bars,
  };
}
