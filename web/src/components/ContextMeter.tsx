import type { TaskContextSize } from "../types";
import { contextView } from "../context-format";

/**
 * 上下文体量徽标：当前会话占了多少模型窗口 + 最近每轮 run 的上下文增量。
 *
 * 口径（很容易看错，见 `web/src/context-format.ts`）：
 * - `tokens` = **最近一次模型调用的 prompt**（当前会话请求体量），不是 usage 累加值；
 * - provider 推不出体量（cursor）或模型窗口未知时，如实显示「未知 / —」+ 原因，不猜数。
 */
export default function ContextMeter({ context }: { context?: TaskContextSize }) {
  const view = contextView(context);
  return (
    <div className="context-meter">
      <div className="context-meter-head">
        <span className="usage-label">Context</span>
        <span className={`context-percent context-tone-${view.tone}`} title={view.title}>
          {view.percentLabel}
        </span>
      </div>
      <span className="context-tokens" title={view.title}>
        {view.tokensLabel}
      </span>
      {view.runsLeftLabel ? <span className="context-hint">{view.runsLeftLabel}</span> : null}
      {view.bars.length ? (
        <div
          className="context-bars"
          title="最近每轮 run 的上下文增量（柱高相对最大值；黄色柱 = 那一轮换了会话）"
        >
          {view.bars.map((bar) => (
            <span
              key={bar.runId}
              className={`context-bar${bar.reset ? " context-bar-reset" : ""}`}
              style={{ height: `${bar.heightPct}%` }}
              title={bar.title}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
