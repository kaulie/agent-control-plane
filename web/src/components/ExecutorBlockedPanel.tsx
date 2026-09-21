import { useEffect, useState } from "react";
import { blockedView } from "../autonomy";
import { submitExecutorReply, type ReplyOutcome } from "../executorReply";
import type { AutonomyTaskDetail } from "../types";

/**
 * **阻塞态面板**：把「卡住了」变成一个能当场回答的现场。
 *
 * 版面（全部来自它的 payload，我们不替它说话）：
 * 1. **谁在挡** + **依据**：分类来自它自己的 `status` / `need.type`，并把是靠哪个字段判出来的写出来；
 * 2. **它在等什么**：`need.description` 全文照抄；它这次没填 `need` 就退到 `reason`，
 *    并在标题里**标明**这段来自 reason（不让人以为它一定说了 need）；
 * 3. **它给的选项**：只有 `need.options` 里**结构化**给了才列（1..N）——**点一个选中，按【确认】
 *    就投递给执行方**（编号是界面的事，用户不用输入）；它没给就不出现这一块；
 * 4. **自由输入永远在**：没有合适的就直接在输入框写自己的意见（走同一个通道）。
 *
 * 看不到时间就说看不到：autonomy 的 payload 没有「何时开始阻塞」，所以只显示
 * 「本页看到这个状态已 N 分钟」（页面自己的观察，明确标注）。
 */
interface Props {
  detail: AutonomyTaskDetail | null;
}

const fmtMinutes = (ms: number): string => {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
};

const ASK_LABEL: Record<string, string> = {
  need: "它在等什么（need.description 原文）",
  reason: "它给的理由（这次它没填 need，照抄 reason）",
  error: "它报的错（原文）",
};

export default function ExecutorBlockedPanel({ detail }: Props) {
  const view = blockedView(detail);
  const [copied, setCopied] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  // 选项是**单选**：点中 → 按【确认】才投递（用户不用输入编号）
  const [selected, setSelected] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<ReplyOutcome | null>(null);
  const optionsKey = (view?.options ?? []).join(" | ");
  useEffect(() => {
    setSelected(null);
    setOutcome(null);
  }, [optionsKey]);

  // 换了任务 / 状态 / 分类 / 问法就重新计时（观察的是「这一段阻塞」持续了多久）
  const key = `${detail?.task_id ?? ""}|${detail?.status ?? ""}|${view?.kind ?? ""}|${(view?.ask ?? "").slice(0, 24)}`;
  useEffect(() => {
    setStartedAt(Date.now());
    setNow(Date.now());
  }, [key]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  if (!view) return null;

  const confirm = async (): Promise<void> => {
    if (selected === null) return;
    const choice = view.options[selected];
    if (!choice) return;
    setSubmitting(true);
    setOutcome(null);
    const result = await submitExecutorReply(choice);
    setOutcome(result);
    setSubmitting(false);
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(view.summaryLine);
      setCopied("已复制");
    } catch {
      setCopied("复制失败（浏览器不给）");
    }
    window.setTimeout(() => setCopied(null), 2000);
  };

  return (
    <section className={`blocked-panel is-${view.kind}`} aria-label="阻塞详情">
      <div className="blocked-head">
        <span className="blocked-kind">{view.kindLabel}</span>
        <span className="blocked-basis">{view.basis}</span>
      </div>

      {view.ask ? (
        <>
          <div className="blocked-ask-label">
            {ASK_LABEL[view.askSource] ?? "它在说什么（原文）"}
          </div>
          <div className="blocked-ask">{view.ask}</div>
        </>
      ) : (
        <div className="blocked-ask blocked-ask-empty">
          它没说明在等什么（need 是空的，reason / error 也没有）
        </div>
      )}

      {view.links.length > 0 ? (
        <div className="blocked-links">
          {view.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              {l.label}
            </a>
          ))}
        </div>
      ) : null}

      {view.options.length > 0 ? (
        <div className="blocked-choices">
          <div className="blocked-ask-label">它给的选项：点一个，然后按【确认】发回去</div>
          <ul className="blocked-options" role="radiogroup" aria-label="它给的选项">
            {view.options.map((option, i) => (
              <li key={option}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected === i}
                  className={`blocked-option${selected === i ? " is-selected" : ""}`}
                  onClick={() => {
                    setSelected(i);
                    setOutcome(null);
                  }}
                >
                  <span className="blocked-option-idx">{i + 1}.</span>
                  <span className="blocked-option-text">{option}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="blocked-confirm-row">
            <button
              type="button"
              className="blocked-confirm"
              disabled={selected === null || submitting}
              onClick={() => void confirm()}
            >
              {submitting ? "提交中…" : "确认"}
            </button>
            <span className={`blocked-confirm-hint${outcome && !outcome.ok ? " is-bad" : ""}`}>
              {outcome
                ? outcome.ok
                  ? `已发给执行方${outcome.receipt ? ` · ${outcome.receipt}` : ""}`
                  : `没有投递：${outcome.error}`
                : selected === null
                  ? "先点一个选项（不用输入编号）"
                  : `将把「${view.options[selected]}」原文发过去`}
            </span>
          </div>
        </div>
      ) : null}

      <div className="blocked-else">
        {view.options.length > 0
          ? "都不合适？也可以直接写在下面的输入框里（你自己的意见）。"
          : "它不是让你选：直接写在下面的输入框里（你自己的意见）。"}
      </div>

      {view.reason && view.reason !== view.ask ? (
        <details className="blocked-reason">
          <summary>它在想什么（执行方的理由）</summary>
          <div className="blocked-reason-text">{view.reason}</div>
        </details>
      ) : null}

      <div className="blocked-tools">
        <button type="button" className="blocked-tool" onClick={() => void copy()}>
          {copied ?? "复制阻塞详情"}
        </button>
        <span className="blocked-observed">
          本页看到这个状态已 {fmtMinutes(now - startedAt)}（页面观察，它那边不给时间）
        </span>
      </div>
    </section>
  );
}
