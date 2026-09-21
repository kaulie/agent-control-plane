import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatDateTime } from "../format";
import { planSteps, statusClass, worldLine } from "../autonomy";
import TaskIdsBar from "./TaskIdsBar";
import type {
  AutonomyMeta,
  AutonomyTaskDetail,
  TaskListRow,
} from "../types";

/**
 * agent 创建路径 = `autonomy` 的任务详情。
 *
 * 和老任务**同一个外壳**：渲染在同一个 `<main className="main">` 里，顶部还是同一个 `TaskIdsBar`
 * （Task / Project / Org / Agent + Agent 创建路径），下面是状态与正文。
 *
 * 只画 autonomy 接口**真给了**的东西：它暂时给不了的（时间线 / 对话消息、token 用量、上下文占用、
 * 停止 / 继续对话）就**留空不显示** —— 不置灰、不写占位；等它的接口补齐（M2：事件 / 消息）再往
 * 这里加，版式不用改（见 docs/autonomy-integration.md）。
 */
interface Props {
  taskId: string;
  /** 列表里那一行：描述 / 轮次 / agent id 先用它，免得首帧空窗。 */
  row?: TaskListRow;
  /** autonomy 自述（地址 / 版本）——只写进 chip 的悬停，**不占版面**。 */
  meta?: AutonomyMeta | null;
  /** 这条 task 所属项目的组织（我们从自己的项目库里取，autonomy 也可能给一份）。 */
  orgId?: string;
  orgName?: string;
}

/** 详情轮询间隔（状态/进展会变；payload 很小）。 */
const REFRESH_MS = 5000;

export default function AutonomyTaskPanel({
  taskId,
  row,
  meta,
  orgId,
  orgName,
}: Props) {
  const [detail, setDetail] = useState<AutonomyTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await api.autonomyTask(taskId));
      setError(null);
    } catch (e) {
      setDetail(null);
      setError(errorText(e));
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const status = String(detail?.status ?? row?.status ?? "");
  const description = String(detail?.description ?? row?.description ?? "");
  const updatedAt =
    (detail?.updated_at ? String(detail.updated_at) : "") ||
    row?.lastUserInputAt ||
    "";
  const world = worldLine(detail);
  const steps = planSteps(detail);
  const source = meta?.url
    ? `autonomy ${meta.url}${meta.version ? ` · v${meta.version}` : ""}`
    : undefined;
  const turns = row?.turns;

  return (
    <>
      <TaskIdsBar
        task={{
          taskId,
          projectId: row?.projectId || detail?.project?.id || "",
          agentId: row?.agentId ?? "",
        }}
        {...(orgId ? { orgId } : {})}
        {...(orgName ? { orgName } : {})}
        agentPath="autonomy"
        {...(source ? { agentPathSource: source } : {})}
      />

      <div className="task-ids task-status-bar" role="group" aria-label="任务状态">
        {status ? (
          <span className={`auto-status ${statusClass(status)}`}>{status}</span>
        ) : null}
        {turns != null ? (
          <span className="task-id-chip is-static" title="autonomy 记的轮次（我们这边没有它的 runs）">
            <span className="task-id-label">轮次</span>
            <code className="task-id-value">{turns}</code>
          </span>
        ) : null}
        {updatedAt ? (
          <span className="task-id-chip is-static" title="autonomy 侧最后更新时间">
            <span className="task-id-label">更新于</span>
            <code className="task-id-value">{formatDateTime(updatedAt)}</code>
          </span>
        ) : null}
      </div>

      <div className="auto-detail">
        {error ? <div className="auto-banner bad">读 autonomy 失败：{error}</div> : null}
        {detail?.error ? (
          <div className="auto-detail-row">
            <span>error</span>
            <span className="auto-err">{String(detail.error)}</span>
          </div>
        ) : null}
        {description ? (
          <div className="auto-detail-row">
            <span>描述</span>
            <span className="auto-detail-text">{description}</span>
          </div>
        ) : null}
        {world ? (
          <div className="auto-detail-row">
            <span>这条任务的世界</span>
            <span>{world}</span>
          </div>
        ) : null}
        {steps.length > 0 ? (
          <div className="auto-detail-row">
            <span>计划步骤</span>
            <span>
              {steps.map((s) => (
                <span
                  key={`${s.planId ?? 0}-${s.step}`}
                  className={`auto-step ${statusClass(s.status)}`}
                >
                  {s.capability}:{s.status}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {detail ? (
          <details className="auto-raw">
            <summary>原始响应（排查用）</summary>
            <pre className="auto-pre">{JSON.stringify(detail, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </>
  );
}
