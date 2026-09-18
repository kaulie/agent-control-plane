import type { TaskStats } from "./types";
import { formatCost, formatMoney } from "./format";

/**
 * UsageBar 上两个「钱」的文案。
 *
 * 起点是一个真实的对账：库里的成本有两个来源，口径差**一个数量级**——
 * - 计费表（`billing_rules`，DeepSeek 官方价目）：整个 cline 历史 ≈ ¥297（≈$42）；
 * - SDK 自己上报的 `totalCost`：≈ $15（它的价卡和我们这张表不是一套）。
 * 所以两个值**必须分开显示、不要相加**，否则页面会给出一个既不是账单也不是上报值的数。
 */

const SDK_TITLE =
  "provider / SDK 自己上报的成本（对比口径）：与左边计费表的值不是一套价卡，不要相加";

function billedTitle(stats: TaskStats): string {
  const parts = ["按计费表 billing_rules 计算（含高峰 / 空闲时段价）"];
  if (stats.billedCurrency) parts.push(`本币 ${stats.billedCurrency}`);
  if (stats.costCents != null) parts.push(`≈ $${(stats.costCents / 100).toFixed(2)}`);
  return parts.join(" · ");
}

export interface UsageCostView {
  /** 计费表口径（本币优先，没有本币时退回美元）。 */
  billed: string;
  billedTitle: string;
  /** SDK 上报口径；没有就显示 `—`。 */
  sdk: string;
  sdkTitle: string;
}

export function usageCostView(stats: TaskStats): UsageCostView {
  const billed =
    stats.billedAmount != null
      ? formatMoney(stats.billedAmount, stats.billedCurrency)
      : formatCost(stats.costCents ?? stats.estimatedCents);
  return {
    billed,
    billedTitle: billedTitle(stats),
    sdk: stats.chargedCents != null ? formatCost(stats.chargedCents) : "—",
    sdkTitle: SDK_TITLE,
  };
}
