import type { Task, TaskStats } from "../types";
import { formatCost, formatDuration, formatTokens } from "../format";

export default function UsageBar({ task, stats }: { task: Task; stats: TaskStats }) {
  const cost = stats.costCents ?? stats.estimatedCents;
  return (
    <div className="usage-bar">
      <div className="usage-item">
        <span className="usage-label">Task</span>
        <span className="usage-value">#{task.taskId.slice(-6)}</span>
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
        <span className="usage-value">{formatCost(cost)}</span>
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
