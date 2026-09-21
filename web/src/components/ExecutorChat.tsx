import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { deliveryReceipt, executorBusy } from "../autonomy";
import { formatDateTime } from "../format";
import ChatInput, { type ChatPayload } from "./ChatInput";
import { onExecutorPrefill } from "../executorPrefill";

/**
 * 给**执行方**（autonomy）发消息 —— 「autonomy 创建的 agent 也要能 chat」。
 *
 * 链路：同一个输入框 → 控制面（按 `via` 选路）→ autonomy `POST /api/tasks { task_id, description }`
 * （= 给同一条 task 的那只 agent 追加一条指令，**忙则排队**，契约 A2③）→ `202 { message_id, queued }`。
 * **本机不跑 run**。
 *
 * `via` 只决定**寻址**（都走控制面代理，都不写我们的库）：
 * - `via="task"`（默认）：我们建的任务（`agentPath=autonomy`）→ `POST /api/tasks/{我们的 id}/messages`；
 * - `via="executor"`：只在 autonomy 那边存在、我们没建过的**对账行** →
 *   `POST /api/autonomy/tasks/{它的 id}/messages`。
 *
 * 三条不假装的规矩：
 * 1. 只收文字 → 不显示附件与 Plan/Agent 模式（**不置灰、不占位**）；
 * 2. 投递成功才清空输入框（失败保留草稿 + 显示原文）；回执只写它真给了的 `message_id` / `queued` / 状态；
 * 3. 它那边的完整对话（事件流）**还没接**（契约 A6.1 待定）→ 这里只列**本页投递过的**，并写明是「本页记录」。
 */
interface Props {
  /**
   * `task`：我们的 taskId（控制面按它找交接记录）；
   * `executor`：对账行的 taskId **就是** autonomy 那边的 id。
   */
  taskId: string;
  /** 寻址方式（见上面注释）；默认 `task`。 */
  via?: "task" | "executor";
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

export default function ExecutorChat({ taskId, via = "task", status, onDelivered }: Props) {
  const [sent, setSent] = useState<Sent[]>([]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = executorBusy(status);
  // 阻塞面板的选项/预填通过这条总线把话塞进输入框（只填不发）
  const [prefill, setPrefill] = useState({ text: "", nonce: 0 });
  useEffect(
    () => onExecutorPrefill((text) => setPrefill((prev) => ({ text, nonce: prev.nonce + 1 }))),
    [],
  );

  const send = async (payload: ChatPayload): Promise<boolean> => {
    setError(null);
    setReceipt(null);
    try {
      // 执行方只收文字：不带 images / mode（后端也会拦带图的请求）。
      const res =
        via === "executor"
          ? await api.sendMessageToExecutor(taskId, payload.text)
          : await api.sendMessage(taskId, payload.text);
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
          {via === "executor"
            ? "这条任务我们没建过（只在 autonomy 那边）：消息按它的 task id 投递给它那只 agent；我们这边不落库、不跑 run"
            : "这条消息投递给 autonomy 那边这只 agent（它忙就排队）；本机不跑 run"}
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
        prefill={prefill}
      />
    </div>
  );
}
