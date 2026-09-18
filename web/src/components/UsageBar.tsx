import type { Task, TaskStats } from "../types";
import { formatDuration, formatTokens } from "../format";
import { usageCostView } from "../usage-cost";

export default function UsageBar({ task, stats }: { task: Task; stats: TaskStats }) {
  // 两个口径分开显示：计费表（本币）vs provider/SDK 上报值。
  const cost = usageCostView(stats);
  return (
    <div className="usage-bar">
      <div className="usage-item">
        <span className="usage-label">Task</span>
        <span className="usage-value">#{task.taskId.slice(-6)}</span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Provider</span>
        <span className="usage-value" title="创建时选定，不可更改">
          {task.provider}
        </span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Model</span>
        <span className="usage-value" title="创建时选定，不可更改">
          {task.model || "（自动）"}
        </span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Tokens</span>
        <span className="usage-value">{formatTokens(stats.totalTokens)}</span>
      </div>
      <div className="usage-item">
        <span className="usage-label">In / Out</span>
        <span className="usage-value">
          {formatTokens(stats.inputTokens)} / {formatTokens(stats.outputTokens)}
        </span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Cache</span>
        <span className="usage-value">
          {formatTokens(stats.cacheReadTokens + stats.cacheWriteTokens)}
        </span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Cost</span>
        <span className="usage-value" title={cost.billedTitle}>
          {cost.billed}
        </span>
      </div>
      <div className="usage-item">
        <span className="usage-label">SDK cost</span>
        <span className="usage-value" title={cost.sdkTitle}>
          {cost.sdk}
        </span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Duration</span>
        <span className="usage-value">{formatDuration(stats.durationMs)}</span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Model calls</span>
        <span className="usage-value">{stats.modelCalls}</span>
      </div>
      <div className="usage-item">
        <span className="usage-label">Tool calls</span>
        <span className="usage-value">{stats.toolCalls}</span>
      </div>
    </div>
  );
}
