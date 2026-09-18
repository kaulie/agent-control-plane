/**
 * 计费模块（billing）— 类型定义。
 *
 * 计费是**独立模块**：模型价目 + 时段规则存在数据库表 `billing_rules` 里
 * （种子见 ./rules.ts 的 DEFAULT_BILLING_RULES），算钱时只按这张表的规则来。
 * provider 适配器不再自带价目表，只把「用量 + 模型 + 时间」交给本模块。
 *
 * 单位 / 币种：
 * - 规则的 `peak` / `offpeak` 价格是**本币（currency）每 1M tokens**；
 * - `usdPerUnit` 只用于把本币金额折算成项目统一的 USD cents（聚合 / 兼容用），
 *   本币金额 `amount` 才是账单口径；
 * - provider / SDK 自己上报的金额原样留在 `CostInfo.chargedCents`，只作对比。
 */

/** 价目时段：高峰 / 空闲（错峰优惠）。 */
export type BillingPeriod = "peak" | "offpeak";

/** 一条规则是怎么被命中的。 */
export type BillingMatchKind = "exact" | "pattern" | "wildcard";

/** 单个时段的价格（本币 / 1M tokens）。 */
export interface BillingPrice {
  /** 缓存命中输入。 */
  cacheHit: number;
  /** 缓存未命中输入。 */
  cacheMiss: number;
  /** 输出。 */
  output: number;
  /** 缓存写入；缺省 = 按 cacheMiss 计。 */
  cacheWrite?: number;
}

/**
 * 错峰（空闲时段）窗口，用 **UTC 分钟数** 表达，避免服务器时区 / 夏令时影响判定：
 * `[startMinute, endMinute)`，跨 0 点就写成 start > end；start === end 表示全天空闲。
 * 例：北京时间 00:30–08:30 = UTC 16:30–00:30 = `{ startMinute: 990, endMinute: 30 }`。
 */
export interface OffPeakWindow {
  startMinute: number;
  endMinute: number;
}

/** 一个模型（或一个 provider 的全部模型）的计费规则。 */
export interface BillingRule {
  /** 主键，例如 `deepseek-v4-flash`。 */
  ruleId: string;
  /** `cline` | `cursor` | `*`（`*` = 任何 provider）。 */
  provider: string;
  /**
   * 模型匹配：
   * - 精确 model id（`deepseek-v4-pro`）；
   * - 或包含片段（`deepseek-v4` 命中 `deepseek-v4-pro`）；
   * - 或 `*`（该 provider 全部模型）。
   */
  model: string;
  displayName?: string;
  /** 本币币种，例如 `CNY`。 */
  currency: string;
  /** 1 个本币单位 = 多少 USD（只用于折算成项目统一的 USD cents）。 */
  usdPerUnit: number;
  peak: BillingPrice;
  offpeak: BillingPrice;
  /** 错峰窗口；`null` = 该规则没有空闲时段（永远按 peak 计）。 */
  offpeakWindow: OffPeakWindow | null;
  /** 命中权重相同时，priority 大的赢（默认 0）。 */
  priority: number;
  enabled: boolean;
  note?: string;
  updatedAt: string;
}

/** 种子规则（无 `updatedAt`，入库时补）。 */
export type BillingRuleSeed = Omit<BillingRule, "updatedAt">;

/** 计费用的 token 分桶。 */
export interface BillingTokenParts {
  cacheHit: number;
  cacheMiss: number;
  cacheWrite: number;
  output: number;
}

/** 落在 `cost_json.billing` 里的计费明细（可逐项核对）。 */
export interface BillingCostInfo {
  ruleId: string;
  provider: string;
  model: string;
  matchedBy: BillingMatchKind;
  period: BillingPeriod;
  /** 计费基准时间（run 起始时刻，ISO8601）。 */
  at: string;
  currency: string;
  usdPerUnit: number;
  /** 本币金额（如元）。 */
  amount: number;
  /** 折算后的 USD cents（= `cost_json.estimatedCents`）。 */
  usdCents: number;
  /** 生效价（本币 / 1M）。 */
  prices: BillingPrice;
  tokens: BillingTokenParts;
  /** 本币分项金额（与 `tokens` 同序）。 */
  breakdown: BillingTokenParts;
  offpeakWindow: OffPeakWindow | null;
}
