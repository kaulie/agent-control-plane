/**
 * 「阻塞面板 → 投递通道」：面板按【确认】时，把选中的选项**真正投递**给执行方。
 *
 * 为什么走这条路：投递（`POST …/messages`，忙则排队）只有一条实现 —— 输入框所在的
 * `ExecutorChat`（回执、错误原文、「本页发过的」记录都在那儿）。面板不自己发第二遍，
 * 而是把这句话交给**当前挂着的那个**通道，拿回它的结果（成功给回执、失败给原文）。
 *
 * 与上一版「预填」的区别：不再把文字塞进输入框让用户再按一次发送 —— 用户**点选一个选项、
 * 按【确认】就是最终答复**（编号是界面的事，他不用输入）。
 *
 * 没有挂载通道（理论上不该发生：autonomy 任务的详情里都有输入框）→ 明确返回失败，
 * **不假装已投递**。
 */
export interface ReplyOutcome {
  ok: boolean;
  /** 投递成功时的回执原文（`message_id` / 前面还有几条）——与输入框显示的是同一句。 */
  receipt?: string;
  /** 没有投递时的原文（400 / 404 / 503 都照说）。 */
  error?: string;
}

type ReplyHandler = (text: string) => Promise<ReplyOutcome>;

const handlers = new Set<ReplyHandler>();

/** 订阅（`ExecutorChat` 挂载时调用）；返回退订函数。 */
export function onExecutorReply(fn: ReplyHandler): () => void {
  handlers.add(fn);
  return () => {
    handlers.delete(fn);
  };
}

/** 把这一句交给当前挂着的投递通道；没挂通道就说清没投。 */
export async function submitExecutorReply(text: string): Promise<ReplyOutcome> {
  const value = text.trim();
  if (!value) return { ok: false, error: "空消息不投递" };
  const handler = Array.from(handlers)[0];
  if (!handler) return { ok: false, error: "页面里没有投递通道（输入框未挂载），没有投递" };
  try {
    return await handler(value);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
