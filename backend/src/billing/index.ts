/**
 * 计费模块（public surface）。
 *
 * 见 ./README.md：规则表 `billing_rules`、时段判定、本币 / USD 折算、命中优先级。
 */
export * from "./types.js";
export {
  DEFAULT_BILLING_RULES,
  DEEPSEEK_OFFPEAK_WINDOW,
  USD_PER_CNY,
  billingPeriodFor,
  isWithinOffPeakWindow,
  matchBillingRule,
  normalizeBillingRuleInput,
  type BillingRuleInput,
  type BillingRuleMatch,
} from "./rules.js";
export {
  billingTokens,
  buildBilledCost,
  priceWithRule,
  pricesForPeriod,
  resolveBilledCost,
  type BuildBilledCostInput,
  type CostSource,
  type ResolvedBilledCost,
} from "./cost.js";
export {
  BillingService,
  createBillingService,
  type BillingInput,
  type BillingRuleSource,
} from "./service.js";
