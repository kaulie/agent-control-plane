import {
  agentPathHint,
  agentPathLabel,
} from "../agent-path";
import type { AgentPath } from "../types";

interface Props {
  /** 这条 task 的 agent 是谁创建的。 */
  path: AgentPath;
  /**
   * 可选补充（写在悬停里，不占版面）：autonomy 侧的数据源，例如 `autonomy :4300 · vff9899c0`。
   * 拿不到就不传 —— **留空不显示**。
   */
  source?: string;
}

/**
 * 「Agent 创建路径」chip（只读，和 `TaskIdsBar` 的 chip 同一套样式）。
 * 老任务（控制面创建）与新入口（autonomy 创建）都在同一个位置显示它 —— 对称，才叫字段。
 */
export default function AgentPathChip({ path, source }: Props) {
  const hint = agentPathHint(path);
  return (
    <span
      className="task-id-chip is-static"
      title={source ? `${hint}\n数据源：${source}` : hint}
    >
      <span className="task-id-label">Agent 创建路径</span>
      <code className="task-id-value">{agentPathLabel(path)}</code>
    </span>
  );
}
