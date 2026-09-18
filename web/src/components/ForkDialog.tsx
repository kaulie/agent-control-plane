import type { ContextView } from "../context-format";

/**
 * 「上下文将满」对话框：用户**下一次发言**时弹（超过告警线、且本 task 还没被"不再提醒"）。
 *
 * 四个选择都明确，不替用户做决定：
 * - Fork 新 task：新建 task（继承工作区 / provider / model / PR）并带上最近历史，
 *   然后把这句话直接发到新 task；
 * - 仍然在本 task 发送；
 * - 不再提醒（本 task，仍发送）—— 之后只保留常驻提示条；
 * - 取消（草稿留在输入框里）。
 */
export type ForkChoice = "fork" | "send" | "send-muted" | "cancel";

export default function ForkDialog({
  view,
  taskId,
  forking,
  onChoose,
}: {
  view: ContextView;
  taskId: string;
  forking: boolean;
  onChoose: (choice: ForkChoice) => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onChoose("cancel")}>
      <div
        className="modal-dialog fork-dialog"
        role="dialog"
        aria-labelledby="fork-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="fork-dialog-title" className="modal-title">
          上下文快满了（{view.percentLabel}）
        </h2>
        <p className="modal-hint">{view.forkHint}</p>
        <ul className="fork-facts">
          <li>
            当前会话体量 <b>{view.tokensLabel}</b>
            （口径：最近一次模型调用的 prompt，不是累计 token）
          </li>
          <li>
            Fork 会新建一个 task 并<b>沿用同一个工作区</b>，带上最近几轮对话与 run 结论；
            完整历史仍留在 <code>#{taskId.slice(-6)}</code> 的时间线里。
          </li>
          <li>留在这个 task 也能继续，但到窗口上限之后就再也发不出消息（不可逆）。</li>
        </ul>
        <div className="modal-actions">
          <button
            type="button"
            className="modal-primary"
            disabled={forking}
            onClick={() => onChoose("fork")}
          >
            {forking ? "正在 Fork…" : "Fork 新 task"}
          </button>
          <button type="button" className="modal-cancel" disabled={forking} onClick={() => onChoose("send")}>
            仍然在本 task 发送
          </button>
          <button
            type="button"
            className="modal-cancel"
            disabled={forking}
            onClick={() => onChoose("send-muted")}
          >
            不再提醒，继续发送
          </button>
        </div>
      </div>
    </div>
  );
}
