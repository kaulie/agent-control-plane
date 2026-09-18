import type { ModelInfo } from "../providers/types.js";

/**
 * 模型窗口（context window / 可用输入预算）缓存。
 *
 * 数据来源：provider 的模型目录（cline 走 `@cline/llms`，deepseek-v4-* 报
 * `contextWindow: 1000000`、`maxInputTokens: 1000000`）。我们**不自己维护价目表式的
 * 硬编码常量**，而是启动时预热一次；查不到就如实返回 undefined（页面显示"窗口未知"，
 * 不给百分比）—— 和计费一样，宁可说不知道，也不给错数。
 *
 * cursor 的模型目录不带窗口信息 → cursor 目前就是 undefined。
 */
const limits = new Map<string, number>();

function key(provider: string | null | undefined, model: string | null | undefined): string {
  return `${(provider ?? "").trim().toLowerCase()}|${(model ?? "").trim().toLowerCase()}`;
}

/** 记住某个 provider 的模型窗口（可重复调用；只记有值的）。 */
export function rememberModelLimits(
  provider: string,
  models: readonly ModelInfo[],
): void {
  for (const model of models) {
    const tokens = model.maxInputTokens ?? model.contextWindow;
    if (typeof tokens === "number" && tokens > 0) {
      limits.set(key(provider, model.id), tokens);
    }
  }
}

/** 同步查窗口：精确命中优先，其次同 provider 下的包含匹配（模型 id 常带后缀）。 */
export function modelContextLimit(
  provider: string | null | undefined,
  model: string | null | undefined,
): number | undefined {
  const wanted = (model ?? "").trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = limits.get(key(provider, wanted));
  if (exact) return exact;
  const prefix = `${(provider ?? "").trim().toLowerCase()}|`;
  let best: { len: number; tokens: number } | undefined;
  for (const [k, tokens] of limits) {
    if (!k.startsWith(prefix)) continue;
    const candidate = k.slice(prefix.length);
    if (!candidate || !wanted.includes(candidate)) continue;
    if (!best || candidate.length > best.len) best = { len: candidate.length, tokens };
  }
  return best?.tokens;
}

interface ModelLister {
  name: string;
  listModels(): Promise<ModelInfo[]>;
}

/** 启动时预热（失败不影响服务：查不到就是"窗口未知"）。 */
export async function warmModelLimits(providers: {
  list(): ModelLister[];
}): Promise<void> {
  for (const provider of providers.list()) {
    try {
      const models = await provider.listModels();
      rememberModelLimits(provider.name, models);
    } catch (err) {
      console.warn(
        `[context] model limits unavailable for ${provider.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function knownModelLimits(): Array<{ provider: string; model: string; tokens: number }> {
  return [...limits.entries()]
    .map(([k, tokens]) => {
      const [provider = "", model = ""] = k.split("|");
      return { provider, model, tokens };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
