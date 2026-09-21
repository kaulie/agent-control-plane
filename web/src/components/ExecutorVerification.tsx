import { verificationView, type VerifyVerdictView } from "../autonomy";
import { formatDateTime } from "../format";
import type { AutonomyTaskDetail } from "../types";

/**
 * 「验证」section：**引擎自己那一侧的「做完了吗」**（docs/verification.md）。
 *
 * 为什么它要单独占一节：`status=unverified` 只是「它自称完成、引擎没认」这个结论，
 * 而**依据**（哪个判据、问的谁、期望什么、实际答什么、为什么没过）之前只能挤在四态条
 * 那一行提示里、或者根本没有。这里把 autonomy 的 `verification` 原样铺开：
 *
 * - **契约**（cycle 1 钉住，之后不改写）：每条判据的要求、它绑的证据槽、期望什么；
 * - **判定记录**：每一次判定一行，最新在前 —— `pass` / `fail` / `inconclusive`，
 *   问的谁（`method`）、期望 vs 实际、原文 `reason`；只有全 `pass` 才算「做完」。
 *
 * 三种「没有」分开说（不假装）：接口上没这个字段 = 引擎从没判过；契约空 = 它自称过 done
 * 但没钉过契约；有契约没判定 = 还没有哪一轮 done 被拿去过。首帧没读到 → 不画。
 */
interface Props {
  detail: AutonomyTaskDetail | null;
}

/** 压成一行并截断（长 `observed` / `reason` 不撑破版面；悬停看全文）。 */
function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export default function VerificationSection({ detail }: Props) {
  const view = verificationView(detail);
  if (!view.loaded) return null;

  return (
    <section className={`auto-verify is-${view.tone}`} aria-label="验证">
      <div className="auto-verify-head">
        <span className="auto-verify-title">验证（引擎判定）</span>
        <span className="auto-verify-hint">{view.headline}</span>
      </div>

      {view.contract.length > 0 ? (
        <ul className="auto-verify-contract">
          {view.contract.map((c) => (
            <li key={c.key} className={`auto-verify-criterion is-${c.last?.tone ?? "none"}`}>
              <div className="auto-verify-crit-head">
                <span className="auto-verify-name">{c.name || `#${c.idx ?? "?"}`}</span>
                <span className={`auto-verify-badge is-${c.last?.tone ?? "none"}`}>
                  {c.last ? c.last.result : "还没判过"}
                </span>
                {c.last?.cycle != null ? (
                  <span className="auto-verify-cycle">cycle {c.last.cycle}</span>
                ) : null}
              </div>
              {c.requirement ? (
                <div className="auto-verify-req">{c.requirement}</div>
              ) : (
                <div className="auto-verify-req is-missing">它没写 requirement，只有下面这个证据槽</div>
              )}
              <div className="auto-verify-meta">
                {c.slot ? <span title="判据绑的证据槽（判定时去解析它）">证据槽 {c.slot}</span> : null}
                {c.expect ? <span title="判据要求的期望（原文）">期望 {c.expect}</span> : null}
                {c.passes + c.fails + c.inconclusives > 1 ? (
                  <span>
                    判过 {c.passes + c.fails + c.inconclusives} 次：pass {c.passes} / fail {c.fails} /
                    inconclusive {c.inconclusives}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="auto-verify-empty">
          没有钉住的完成契约（它第一轮答复没给 completion_contract）—— 引擎没有可对照的判据。
        </div>
      )}

      {view.verdicts.length > 0 ? (
        <details className="auto-verify-log">
          <summary>
            判定记录（{view.counts.total} 次：pass {view.counts.pass} / fail {view.counts.fail} /
            inconclusive {view.counts.inconclusive}）· 最新在前
          </summary>
          <ul>
            {view.verdicts.slice(0, 12).map((v) => (
              <VerdictRow key={v.key} verdict={v} />
            ))}
          </ul>
          {view.verdicts.length > 12 ? (
            <div className="auto-verify-more">
              …还有 {view.verdicts.length - 12} 次更早的判定（「原始响应」里有全部）
            </div>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function VerdictRow({ verdict }: { verdict: VerifyVerdictView }) {
  return (
    <li className={`auto-verify-verdict is-${verdict.tone}`}>
      <div className="auto-verify-verdict-head">
        <span className={`auto-verify-badge is-${verdict.tone}`}>{verdict.result || "?"}</span>
        <span className="auto-verify-verdict-crit">{verdict.criterion || "（没写判据名）"}</span>
        {verdict.cycle != null ? (
          <span className="auto-verify-cycle">cycle {verdict.cycle}</span>
        ) : null}
        {verdict.method ? (
          <span className="auto-verify-method" title="判定问的权威来源">
            问的 {verdict.method}
          </span>
        ) : null}
        {verdict.createdAt ? (
          <span className="auto-verify-at">{formatDateTime(verdict.createdAt)}</span>
        ) : null}
      </div>
      {verdict.expected || verdict.observed ? (
        <div className="auto-verify-eo">
          <span>期望 {truncate(verdict.expected, 120) || "（没写）"}</span>
          <span title={verdict.observed}>
            实际 {truncate(verdict.observed, 160) || "（没写）"}
          </span>
        </div>
      ) : null}
      {verdict.evidence ? <div className="auto-verify-evidence">证据 {verdict.evidence}</div> : null}
      {verdict.reason ? (
        <div className="auto-verify-reason" title={verdict.reason}>
          {truncate(verdict.reason, 240)}
        </div>
      ) : null}
    </li>
  );
}
