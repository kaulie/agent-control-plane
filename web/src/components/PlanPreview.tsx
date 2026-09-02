import { useEffect, useMemo, useState } from "react";
import type { PlanRunContent } from "../plan-content";
import { formatTime, formatDuration } from "../format";
import MarkdownReader from "./MarkdownReader";

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(-8) : runId;
}

export default function PlanPreview({
  planRuns,
  running,
  activeRunId,
}: {
  planRuns: PlanRunContent[];
  running: boolean;
  activeRunId?: string;
}) {
  const defaultRunId = useMemo(() => {
    if (activeRunId && planRuns.some((p) => p.runId === activeRunId)) {
      return activeRunId;
    }
    return planRuns[0]?.runId ?? "";
  }, [planRuns, activeRunId]);

  const [selectedRunId, setSelectedRunId] = useState(defaultRunId);

  useEffect(() => {
    setSelectedRunId(defaultRunId);
  }, [defaultRunId]);

  const selected = planRuns.find((p) => p.runId === selectedRunId) ?? planRuns[0];

  if (!selected) {
    return (
      <div className="plan-preview plan-preview-empty">
        <p>暂无 Plan 内容。使用 Plan 模式发送消息后，计划将在此处以 Markdown 格式展示。</p>
      </div>
    );
  }

  const run = selected.run;
  const isLive =
    running && activeRunId === selected.runId && run?.status === "running";

  return (
    <div className="plan-preview">
      <div className="plan-preview-toolbar">
        {planRuns.length > 1 ? (
          <label className="plan-preview-select-wrap">
            <span className="plan-preview-select-label">版本</span>
            <select
              className="plan-preview-select"
              value={selected.runId}
              onChange={(e) => setSelectedRunId(e.target.value)}
            >
              {planRuns.map((p, i) => (
                <option key={p.runId} value={p.runId}>
                  {i === 0 ? "最新" : `较早 #${planRuns.length - i}`}
                  {p.startedAt ? ` · ${formatTime(p.startedAt)}` : ""}
                  {` · ${shortRunId(p.runId)}`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="plan-preview-meta">
            {selected.startedAt ? formatTime(selected.startedAt) : "Plan"}
          </span>
        )}
        <div className="plan-preview-badges">
          {isLive && <span className="plan-preview-live">生成中…</span>}
          {run?.status === "finished" && run.durationMs != null && (
            <span className="plan-preview-badge">
              耗时 {formatDuration(run.durationMs)}
            </span>
          )}
          {run?.status === "error" && (
            <span className="plan-preview-badge plan-preview-badge-error">出错</span>
          )}
        </div>
      </div>

      {selected.exportedPath && (
        <div className="plan-preview-export">
          已导出：
          <code title={selected.exportedPath}>
            {selected.exportedFileName ?? selected.exportedPath}
          </code>
        </div>
      )}

      <div className="plan-preview-body">
        <MarkdownReader source={selected.markdown} />
      </div>
    </div>
  );
}
