import { useState } from "react";
import { api, errorText } from "../api";
import { deliveryReceipt, executorBusy } from "../autonomy";
import { formatDateTime } from "../format";
import ChatInput, { type ChatPayload } from "./ChatInput";

/**
 * 给**执行方**（autonomy）发消息 —— 「autonomy 创建的 agent 也要能 chat」。
 *
 * 链路：同一个输入框 → 控制面 `POST /api/tasks/{我们的 id}/messages` → autonomy
 * `POST /api/tasks { task_id, description }`（= 给同一条 task 的那只 agent 追加一条指令，**忙则排队**，
 * 契约 A2④）→ `202 { message_id, queued }`。**本机不跑 run**。
 *
 * 三条不假装的规矩：
 * 1. 只收文字 → 不显示附件与 Plan/Agent 模式（**不置灰、不占位**）；
 * 2. 投递成功才清空输入框（失败保留草稿 + 显示原文）；回执只写它真给了的 `message_id` / `queued` / 状态；
 * 3. 它那边的完整对话（事件流）**还没接**（契约 A6.1 待定）→ 这里只列**本页投递过的**，并写明是「本页记录」。
 */
interface Props {
  /** 我们的 taskId（控制面按它找交接记录）。 */
  taskId: string;
  /** 执行方状态（running / pending…）——决定「忙则排队」的措辞。 */
  status: string;
  /** 投递成功后回调（详情/计划区立刻刷新一次）。 */
  onDelivered?: () => void;
}

interface Sent {
  text: string;
  at: string;
  messageId?: number;
  queueAhead?: number;
}

export default function ExecutorChat({ taskId, status, onDelivered }: Props) {
  const [sent, setSent] = useState<Sent[]>([]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = executorBusy(status);

  const send = async (payload: ChatPayload): Promise<boolean> => {
    setError(null);
    setReceipt(null);
    try {
      // 执行方只收文字：不带 images / mode（后端也会拦带图的请求）。
      const res = await api.sendMessage(taskId, payload.text);
      setReceipt(deliveryReceipt(res));
      setSent((prev) => [
        ...prev,
        {
          text: payload.text,
          at: new Date().toISOString(),
          ...(res.messageId != null ? { messageId: res.messageId } : {}),
          ...(typeof res.queueAhead === "number" ? { queueAhead: res.queueAhead } : {}),
        },
      ]);
      onDelivered?.();
      return true;
    } catch (e) {
      // 400（带图 / 空）/ 404（执行方没有这条 task）/ 503（不可达）都按原文说清：没有投递。
      setError(errorText(e));
      return false;
    }
  };

  return (
    <div className="executor-chat">
      <div className="executor-chat-head">
        <span className="task-id-label">发给执行方</span>
        <span className="auto-plan-hint">
          这条消息投递给 autonomy 那边这只 agent（它忙就排队）；本机不跑 run
        </span>
      </div>
      {error ? <div className="auto-banner bad">没有投递：{error}</div> : null}
      {receipt ? <div className="executor-receipt">{receipt}</div> : null}
      {sent.length > 0 ? (
        <>
          <div className="auto-plan-hint executor-sent-hint">
            本页发过的；它那边的完整对话（事件流）还没接
          </div>
          <ul className="executor-sent">
            {sent.map((m) => (
              <li key={`${m.at}-${m.text.slice(0, 12)}`}>
                <span className="executor-sent-time">{formatDateTime(m.at)}</span>
                <span className="executor-sent-text">{m.text}</span>
                <span className="executor-sent-meta">
                  已投递
                  {m.messageId != null ? ` · 指令 #${m.messageId}` : ""}
                  {typeof m.queueAhead === "number" && m.queueAhead > 0
                    ? ` · 当时前面还有 ${m.queueAhead} 条`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ChatInput
        onSend={send}
        disabled={false}
        running={busy}
        queueLength={0}
        hideMode
        allowImages={false}
        placeholderOverride={
          busy
            ? "执行方工作中，消息将排到它后面…（只收文字）"
            : "发一条指令给执行方（autonomy）…（只收文字）"
        }
      />
    </div>
  );
}
