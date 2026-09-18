/**
 * 上下文（context）体量口径 —— 纯函数，前端/网关共用同一套定义。
 *
 * 背景（2026-09 实测，见 PR #81 讨论）：一个 task 的 SDK 会话是**只增不减**的消息列表，
 * 长到模型窗口（deepseek-v4-* = 1,000,000）就会永远卡死（`pdf-reader` 就是这样死的）。
 * 所以页面上必须能看见"当前会话占了多少窗口"。
 *
 * ## usage 事件的真实语义（必须记住，容易搞错）
 *
 * - **cline**：每次模型调用 emit 一条 usage 事件，值是**本 run 内累计**的 prompt tokens
 *   （run 开始时从 0 计）。所以：
 *     - 第 i 次调用的 prompt = `v_i − v_{i−1}`（第 1 次 = `v_1`）；
 *     - 同一个值重复 emit（收尾事件）→ Δ=0，忽略；
 *     - **`v` 本身不是上下文体量**（它是和，38 次调用后就 38.9M）。
 *   实测：pdf-reader 最后一次调用 prompt = 38,962,680 − 37,916,440 = **1,046,240**，
 *   下一次请求就越过 1,048,576 —— 完全对上。
 * - **cursor**：usage 是**该 agent 生命周期累计**（所有 run 都一样的大数，`model_calls` 记 0/1），
 *   推不出单次请求体量 → 本模块返回 `available: false`（宁可说不知道，也不要给错数）。
 */

/** 预警线（变黄）：到了就该开始留意。 */
export const CONTEXT_WARN_PERCENT = 70;
/** 告警线（建议 fork 新 task）：留给用户决策。 */
export const CONTEXT_ALERT_PERCENT = 85;

/** 能推出单次请求体量的 provider。 */
export const CONTEXT_PROBE_PROVIDERS: readonly string[] = ["cline"];

export function supportsContextProbe(provider: string | null | undefined): boolean {
  return CONTEXT_PROBE_PROVIDERS.includes((provider ?? "").trim().toLowerCase());
}

/** 一条 usage 采样（同一 run 内按时间升序）。 */
export interface ContextUsageSample {
  runId: string;
  at: string;
  tokens: number;
}

/** 一轮 run 的上下文轨迹。 */
export interface ContextRunSample {
  runId: string;
  at: string;
  model?: string;
  /** 该 run 采样到的模型调用数（去掉重复 emit 之后）。 */
  calls: number;
  /** 该 run 第一次调用的 prompt（≈ 这一轮开始时会话多满）。 */
  startTokens: number;
  /** 该 run 最后一次调用的 prompt（≈ 这一轮结束时会话多满）。 */
  endTokens: number;
  /** `endTokens − startTokens`：这一轮自己长了多少。 */
  growthTokens: number;
  /** 首调明显小于上一轮末调 → 说明这轮换了会话（重启 / 轮转）。 */
  reset: boolean;
}

export interface TaskContextSize {
  provider: string;
  /** 数据是否可用（cursor 等推不出体量的 provider = false）。 */
  available: boolean;
  /** 不可用/有保留时的说明，给 UI 直接展示。 */
  note?: string;
  model?: string;
  /** 模型窗口（tokens）；未知则不给百分比。 */
  limit?: number;
  /** **当前会话的请求体量**（最近一次模型调用的 prompt）。 */
  tokens?: number;
  percent?: number;
  sampledAt?: string;
  /** 最近若干轮 run（新的在后）。 */
  runs: ContextRunSample[];
  /** 最近几轮的平均增量（用于估剩余轮数）。 */
  avgGrowthTokens?: number;
  /** 估算：到告警线（CONTEXT_ALERT_PERCENT）还能跑几轮。 */
  estimatedRunsLeft?: number;
  thresholds: { warn: number; alert: number };
}

export interface BuildContextSizeInput {
  provider: string;
  model?: string;
  limit?: number;
  /** 每条 usage 采样，按时间升序；可以只给最近若干轮 run 的。 */
  samples: readonly ContextUsageSample[];
  /** 每个 run 的 model（可选，用于展示）。 */
  modelByRun?: Record<string, string | undefined>;
  /** 最多展示多少轮 run（默认 12）。 */
  maxRuns?: number;
}

/** 把"同一 run 内的累计值"折成"每次调用的 prompt"。 */
function perCallPrompts(values: readonly number[]): number[] {
  const prompts: number[] = [];
  let prev = 0;
  for (const value of values) {
    const delta = value - prev;
    prev = value;
    // 重复 emit（收尾事件）Δ=0；倒退说明数据异常 → 跳过，不要污染体量。
    if (delta > 0) prompts.push(delta);
  }
  return prompts;
}

export function buildContextSize(input: BuildContextSizeInput): TaskContextSize {
  const thresholds = { warn: CONTEXT_WARN_PERCENT, alert: CONTEXT_ALERT_PERCENT };
  const provider = (input.provider ?? "").trim().toLowerCase();
  const base: TaskContextSize = {
    provider,
    available: false,
    ...(input.model ? { model: input.model } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
    runs: [],
    thresholds,
  };

  if (!supportsContextProbe(provider)) {
    return {
      ...base,
      note: `${provider || "该 provider"} 的 usage 是 agent 累计值，推不出单次请求体量`,
    };
  }

  // 按 run 分组（保持出现顺序 = 时间升序）。
  const byRun = new Map<string, ContextUsageSample[]>();
  for (const s of input.samples) {
    const list = byRun.get(s.runId);
    if (list) list.push(s);
    else byRun.set(s.runId, [s]);
  }

  const runs: ContextRunSample[] = [];
  for (const [runId, list] of byRun) {
    const prompts = perCallPrompts(list.map((s) => s.tokens));
    if (!prompts.length) continue;
    const first = prompts[0]!;
    const last = prompts[prompts.length - 1]!;
    const model = input.modelByRun?.[runId];
    runs.push({
      runId,
      at: list[list.length - 1]!.at,
      ...(model ? { model } : {}),
      calls: prompts.length,
      startTokens: first,
      endTokens: last,
      growthTokens: last - first,
      reset: false,
    });
  }

  const maxRuns = Math.max(1, input.maxRuns ?? 12);
  const trimmed = runs.slice(-maxRuns);
  // 标记"换了会话"：首调明显小于上一轮末调（阈值取 20%，避免正常波动误报）。
  for (let i = 1; i < trimmed.length; i += 1) {
    const prev = trimmed[i - 1]!;
    const cur = trimmed[i]!;
    if (prev.endTokens > 0 && cur.startTokens < prev.endTokens * 0.8) {
      cur.reset = true;
    }
  }

  const last = trimmed[trimmed.length - 1];
  if (!last) {
    return { ...base, runs: [], note: "还没有带上 usage 的 run（无法估算上下文体量）" };
  }

  const growths = trimmed.slice(-5).map((r) => r.growthTokens).filter((g) => g > 0);
  const avgGrowth = growths.length
    ? Math.round(growths.reduce((a, b) => a + b, 0) / growths.length)
    : undefined;
  const limit = input.limit;
  const tokens = last.endTokens;
  const percent = limit ? Math.round((tokens / limit) * 1000) / 10 : undefined;
  const alertBudget = limit ? (limit * CONTEXT_ALERT_PERCENT) / 100 : undefined;
  const estimatedRunsLeft =
    alertBudget != null && avgGrowth && avgGrowth > 0 && alertBudget > tokens
      ? Math.floor((alertBudget - tokens) / avgGrowth)
      : undefined;

  return {
    ...base,
    available: true,
    tokens,
    sampledAt: last.at,
    runs: trimmed,
    ...(percent != null ? { percent } : {}),
    ...(avgGrowth ? { avgGrowthTokens: avgGrowth } : {}),
    ...(estimatedRunsLeft != null ? { estimatedRunsLeft } : {}),
  };
}
