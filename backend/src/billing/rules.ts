import type {
  BillingMatchKind,
  BillingPeriod,
  BillingPrice,
  BillingRule,
  BillingRuleSeed,
  OffPeakWindow,
} from "./types.js";

/** 一条规则的命中结果。 */
export interface BillingRuleMatch {
  rule: BillingRule;
  matchedBy: BillingMatchKind;
}

/**
 * DeepSeek 官方错峰（空闲）时段：北京时间 00:30–08:30
 * = UTC 16:30–00:30（跨 0 点：start > end）。
 * 存 UTC 分钟数，服务器时区 / 夏令时都不影响判定。
 */
export const DEEPSEEK_OFFPEAK_WINDOW: OffPeakWindow = {
  startMinute: 16 * 60 + 30,
  endMinute: 30,
};

/**
 * 折算率：1 元 ≈ 0.1408 美元。
 * 只用于把本币金额折成项目统一的 USD cents 字段（`cost_json.estimatedCents` /
 * 任务统计），**账单口径是本币金额**。改这里等于改所有 CNY 规则的折算值。
 */
export const USD_PER_CNY = 1 / 7.1;

const OFFPEAK_NOTE = "空闲时段 = 北京时间 00:30–08:30（UTC 16:30–00:30）";

/**
 * 内置种子规则（元 / 1M tokens），来源：DeepSeek 官方价目表。
 *
 * 只在表里缺这一行时补种（`INSERT OR IGNORE`）：运维改过的行不会被覆盖。
 * 想停用内置行请把 `enabled` 置 0（删掉会在下次启动补回来）。
 */
export const DEFAULT_BILLING_RULES: BillingRuleSeed[] = [
  {
    ruleId: "deepseek-v4-flash",
    provider: "cline",
    model: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    currency: "CNY",
    usdPerUnit: USD_PER_CNY,
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offpeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    offpeakWindow: DEEPSEEK_OFFPEAK_WINDOW,
    priority: 10,
    enabled: true,
    note: `DeepSeek 官方价目（元 / 1M）。${OFFPEAK_NOTE}`,
  },
  {
    ruleId: "deepseek-v4-flash-vision-exp",
    provider: "cline",
    model: "deepseek-v4-flash-vision-exp",
    displayName: "DeepSeek V4 Flash Vision Exp",
    currency: "CNY",
    usdPerUnit: USD_PER_CNY,
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offpeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    offpeakWindow: DEEPSEEK_OFFPEAK_WINDOW,
    priority: 10,
    enabled: true,
    note: `flash 变体，暂按 flash 档计（官方未单列）。${OFFPEAK_NOTE}`,
  },
  {
    ruleId: "deepseek-v4-pro",
    provider: "cline",
    model: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    currency: "CNY",
    usdPerUnit: USD_PER_CNY,
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offpeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    offpeakWindow: DEEPSEEK_OFFPEAK_WINDOW,
    priority: 10,
    enabled: true,
    note: `DeepSeek 官方价目（元 / 1M）。${OFFPEAK_NOTE}`,
  },
];

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** 某时刻是否落在错峰窗口里（`start === end` = 全天空闲）。 */
export function isWithinOffPeakWindow(
  window: OffPeakWindow,
  utcMinutes: number,
): boolean {
  const { startMinute, endMinute } = window;
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) {
    return utcMinutes >= startMinute && utcMinutes < endMinute;
  }
  // 跨 0 点：16:30–00:30 这种
  return utcMinutes >= startMinute || utcMinutes < endMinute;
}

/**
 * 计费时段判定：按**时刻的 UTC 分钟**比窗口，和服务器时区无关。
 * 无窗口 / 时间解析失败 = peak（宁可少打折，不要算少收钱）。
 */
export function billingPeriodFor(
  rule: Pick<BillingRule, "offpeakWindow">,
  at: string | Date,
): BillingPeriod {
  const window = rule.offpeakWindow;
  if (!window) return "peak";
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return "peak";
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return isWithinOffPeakWindow(window, minutes) ? "offpeak" : "peak";
}

/** 命中优先级：精确 id > 更长的包含片段 > 通配；同档先看 provider 是否精确，再看 priority。 */
export function matchBillingRule(
  rules: readonly BillingRule[],
  provider: string | null | undefined,
  model: string | null | undefined,
): BillingRuleMatch | undefined {
  const wantedProvider = norm(provider);
  const wantedModel = norm(model);
  const candidates: Array<{
    rule: BillingRule;
    matchedBy: BillingMatchKind;
    score: number[];
  }> = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const ruleProvider = norm(rule.provider);
    if (ruleProvider !== "*" && ruleProvider !== wantedProvider) continue;

    const ruleModel = norm(rule.model);
    let matchedBy: BillingMatchKind;
    let rank: number;
    let patternLength = 0;
    if (!ruleModel || ruleModel === "*") {
      matchedBy = "wildcard";
      rank = 0;
    } else if (wantedModel && ruleModel === wantedModel) {
      matchedBy = "exact";
      rank = 2;
    } else if (wantedModel && wantedModel.includes(ruleModel)) {
      matchedBy = "pattern";
      rank = 1;
      patternLength = ruleModel.length;
    } else {
      continue;
    }

    candidates.push({
      rule,
      matchedBy,
      score: [rank, ruleProvider === "*" ? 0 : 1, patternLength, rule.priority],
    });
  }

  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    for (let i = 0; i < a.score.length; i += 1) {
      const diff = b.score[i] - a.score[i];
      if (diff) return diff;
    }
    return a.rule.ruleId.localeCompare(b.rule.ruleId);
  });
  const winner = candidates[0];
  return { rule: winner.rule, matchedBy: winner.matchedBy };
}

/**
 * 写接口的入参（`PUT /api/billing/rules/:ruleId`）。全部字段都当 unknown，
 * 由 `normalizeBillingRuleInput` 校验并补齐 —— 非法值直接抛 Error（路由转 400）。
 */
export interface BillingRuleInput {
  provider?: unknown;
  model?: unknown;
  displayName?: unknown;
  currency?: unknown;
  usdPerUnit?: unknown;
  peak?: unknown;
  offpeak?: unknown;
  offpeakWindow?: unknown;
  priority?: unknown;
  enabled?: unknown;
  note?: unknown;
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} 必填`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function requireNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是数字`);
  if (opts.integer && !Number.isInteger(n)) throw new Error(`${field} 必须是整数`);
  if (opts.min != null && n < opts.min) throw new Error(`${field} 不能小于 ${opts.min}`);
  if (opts.max != null && n > opts.max) throw new Error(`${field} 不能大于 ${opts.max}`);
  return n;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function parsePrice(value: unknown, field: string): BillingPrice {
  const raw = asRecord(value, field);
  const cacheWrite =
    raw.cacheWrite == null
      ? undefined
      : requireNumber(raw.cacheWrite, `${field}.cacheWrite`, { min: 0 });
  return {
    cacheHit: requireNumber(raw.cacheHit, `${field}.cacheHit`, { min: 0 }),
    cacheMiss: requireNumber(raw.cacheMiss, `${field}.cacheMiss`, { min: 0 }),
    output: requireNumber(raw.output, `${field}.output`, { min: 0 }),
    ...(cacheWrite != null ? { cacheWrite } : {}),
  };
}

/** `null` / 省略 = 没有空闲时段；两个分钟值都在 [0, 1440)。 */
function parseOffPeakWindow(value: unknown, field: string): OffPeakWindow | null {
  if (value == null) return null;
  const raw = asRecord(value, field);
  return {
    startMinute: requireNumber(raw.startMinute, `${field}.startMinute`, {
      min: 0,
      max: 1439,
      integer: true,
    }),
    endMinute: requireNumber(raw.endMinute, `${field}.endMinute`, {
      min: 0,
      max: 1439,
      integer: true,
    }),
  };
}

/** 校验并补齐一条规则（缺失的峰谷价会互相兜底，避免漏写一侧导致算错）。 */
export function normalizeBillingRuleInput(
  ruleId: string,
  input: BillingRuleInput,
  updatedAt = new Date().toISOString(),
): BillingRule {
  const id = requireText(ruleId, "ruleId");
  const peak = parsePrice(input.peak, "peak");
  const offpeak = parseOffPeakWindow(input.offpeakWindow, "offpeakWindow")
    ? parsePrice(input.offpeak, "offpeak")
    : input.offpeak == null
      ? { ...peak }
      : parsePrice(input.offpeak, "offpeak");
  const displayName = optionalText(input.displayName);
  const note = optionalText(input.note);
  return {
    ruleId: id,
    provider: requireText(input.provider, "provider"),
    model: requireText(input.model, "model"),
    ...(displayName ? { displayName } : {}),
    currency: requireText(input.currency ?? "USD", "currency"),
    usdPerUnit:
      input.usdPerUnit == null
        ? 1
        : requireNumber(input.usdPerUnit, "usdPerUnit", { min: 0 }),
    peak,
    offpeak,
    offpeakWindow: parseOffPeakWindow(input.offpeakWindow, "offpeakWindow"),
    priority:
      input.priority == null
        ? 0
        : requireNumber(input.priority, "priority", { integer: true }),
    enabled: input.enabled == null ? true : Boolean(input.enabled),
    ...(note ? { note } : {}),
    updatedAt,
  };
}
