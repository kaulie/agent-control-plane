import type { TaskStats } from "./types";
import { formatCost, formatMoney } from "./format";

/**
 * UsageBar 上两个「钱」的文案。
 *
 * 库里实际成本的取值顺序是 **计费表 > provider/SDK 上报 > 旧估算**
 * （`backend/src/billing/cost.ts` 的 `resolveBilledCost`）：
 *
 * - 命中了 `billing_rules` 的 run（cline / DeepSeek）：Cost = 表算出来的钱（本币，如 ¥297.26），
 *   SDK cost = 上报值（如 $14.96）—— 两个口径**不同**，所以分开显示、不要相加；
 * - 没有规则的 run（cursor 或其他未入库的模型）：实际成本**就是上报值**，
 *   两个格子显示同一个数（此时不存在「两套价卡」的问题）。
 */

const SDK_SEPARATE_TITLE =
  "provider / SDK 自己上报的成本（对比口径）：与左边计费表的值不是一套价卡，不要相加";
const SDK_SAME_TITLE =
  "这行没有命中计费表规则，实际成本就按上报值计 —— 所以和左边的 Cost 是同一个数";

function billedTitle(stats: TaskStats): string {
  const sources = stats.costSources;
  const ruleRuns = sources?.rule ?? 0;
  const reportedRuns = sources?.reported ?? 0;
  const estimateRuns = sources?.estimate ?? 0;
  const parts: string[] = [];
  if (ruleRuns > 0) {
    parts.push(`按计费表 billing_rules 计算（${ruleRuns} 轮，含高峰 / 空闲时段价）`);
    if (stats.billedCurrency) parts.push(`本币 ${stats.billedCurrency}`);
  }
  if (reportedRuns > 0 && ruleRuns === 0) {
    parts.push(`实际成本按 provider / SDK 上报值（${reportedRuns} 轮，没有计费表规则）`);
  } else if (reportedRuns > 0) {
    parts.push(`另有 ${reportedRuns} 轮没规则、按上报值计`);
  }
  if (estimateRuns > 0 && ruleRuns === 0 && reportedRuns === 0) {
    parts.push(`旧本地估算（${estimateRuns} 轮：没有计费表规则，SDK 也没返回成本）`);
  }
  if (parts.length === 0) parts.push("按现有口径计算的成本");
  if (stats.costCents != null) parts.push(`≈ $${(stats.costCents / 100).toFixed(2)}`);
  return parts.join(" · ");
}

export interface UsageCostView {
  /** 实际成本（本币优先；没有计费表明细时用美元）。 */
  billed: string;
  billedTitle: string;
  /** provider / SDK 上报口径（没有独立上报值时就与 `billed` 同值）。 */
  sdk: string;
  sdkTitle: string;
  /** 两个口径是不是同一个数（没有计费表规则时必然相同）。 */
  same: boolean;
}

export function usageCostView(stats: TaskStats): UsageCostView {
  const billed =
    stats.billedAmount != null
      ? formatMoney(stats.billedAmount, stats.billedCurrency)
      : formatCost(stats.costCents ?? stats.estimatedCents);
  const hasReported = stats.chargedCents != null;
  const sdk = hasReported ? formatCost(stats.chargedCents) : billed;
  return {
    billed,
    billedTitle: billedTitle(stats),
    sdk,
    sdkTitle:
      hasReported && stats.costSources?.rule !== 0 ? SDK_SEPARATE_TITLE : SDK_SAME_TITLE,
    same: sdk === billed,
  };
}
