import { executorPhaseView } from "../autonomy";
import type { AutonomyTaskDetail } from "../types";

/**
 * 主界面顶部的**四态条**：规划中 / 执行中 / 阻塞 / 已完成。
 *
 * 「agent 由 autonomy 创建」的任务（我们建的 `agentPath=autonomy` 与只在它那边存在的对账行）
 * 都画这条 —— 它比原始状态（`running` / `unverified` / `stopped`…）直白得多，
 * 并且在右边**照实写依据**（哪一步没执行、为什么算阻塞、验证为什么没过）。
 *
 * 判定规则与两条硬口径见 `src/autonomy.ts` 的 `executorPhaseView`；原始状态放悬停里，
 * 不隐藏（口径是「显示它真给的」，不是「换个说法盖过去」）。
 */
interface Props {
  detail: AutonomyTaskDetail | null;
  /** 首帧还没读到 → 不画（免得先闪一个「规划中」再变）。 */
  loaded?: boolean;
}

export default function ExecutorPhaseBar({ detail, loaded = true }: Props) {
  if (!loaded) return null;
  const view = executorPhaseView(detail);
  return (
    <div
      className={`exec-phase is-${view.phase}`}
      role="status"
      aria-live="polite"
      data-phase={view.phase}
      title={view.raw ? `执行方原始状态：${view.raw}` : undefined}
    >
      <span className="exec-phase-dot" aria-hidden="true" />
      <span className="exec-phase-label">{view.label}</span>
      <span className="exec-phase-hint">{view.hint}</span>
    </div>
  );
}
