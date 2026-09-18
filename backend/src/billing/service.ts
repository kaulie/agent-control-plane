import type { CostInfo } from "../types.js";
import { buildBilledCost, type BuildBilledCostInput } from "./cost.js";
import type { BillingRule } from "./types.js";

/** 规则来源：`Store` 实现 `listBillingRules()`（读 `billing_rules` 表）。 */
export interface BillingRuleSource {
  listBillingRules(): BillingRule[];
}

/** 计费入参（规则由服务自己现读表，调用方不用管）。 */
export type BillingInput = Omit<BuildBilledCostInput, "rules">;

/**
 * 计费服务：唯一知道「钱怎么算」的地方。
 *
 * 每次调用都现读表 —— 改了 `billing_rules` 立即生效，不需要重启网关。
 */
export class BillingService {
  constructor(private readonly source: BillingRuleSource) {}

  /** 当前生效的规则（含停用行，便于页面展示）。 */
  listRules(): BillingRule[] {
    return this.source.listBillingRules();
  }

  /** 按表算这条 run 的钱；没有规则命中且没有可保留的值时返回 `undefined`。 */
  costFor(input: BillingInput): CostInfo | undefined {
    return buildBilledCost({ ...input, rules: this.listRules() });
  }
}

export function createBillingService(source: BillingRuleSource): BillingService {
  return new BillingService(source);
}
