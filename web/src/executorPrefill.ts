/**
 * 「把一句话填进执行方输入框」的最小通道。
 *
 * 为什么不是 props：阻塞面板（`ExecutorBlockedPanel`）在**详情顶部**，而输入框有两个家 ——
 * 我们建的任务在 `App.tsx`（`ExecutorChat`），只在 autonomy 那边存在的对账行在 `ExecutorTaskBody` 里。
 * 为了一个「填字」动作往下穿透两层 props 不划算；这里就一条总线：面板发一句、
 * **当前挂着的那个输入框**接住它（没挂就没人接，不报错）。
 *
 * 它只做「填进输入框」，**不直接投递** —— 投递不可逆（会给那只 agent 追加指令并让它继续跑），
 * 让用户看一眼再按发送。
 */
type Listener = (text: string) => void;

const listeners = new Set<Listener>();

/** 订阅（`ExecutorChat` 挂载时调用）；返回退订函数。 */
export function onExecutorPrefill(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 请当前挂着的输入框把这句话填上并聚焦。 */
export function requestExecutorPrefill(text: string): void {
  const value = text.trim();
  if (!value) return;
  for (const fn of listeners) fn(value);
}
