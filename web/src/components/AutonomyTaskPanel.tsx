import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatDateTime } from "../format";
import { statusClass, worldLine } from "../autonomy";
import PlanSection from "./ExecutorPlan";
import ExecutorChat from "./ExecutorChat";
import ExecutorPhaseBar from "./ExecutorPhaseBar";
import TaskIdsBar from "./TaskIdsBar";
import type { AutonomyMeta, AutonomyTaskDetail, TaskListRow } from "../types";

/**
 * 「agent 由 autonomy 创建」那部分数据的展示件（和老任务共用同一套版式）。
 *
 * 只画 autonomy 接口**真给了**的东西：状态 / 轮次 / 描述 / 项目·组织 / error / plans·steps /
 * 原始响应折叠。它暂时给不了的（时间线 / 对话消息、token 用量、上下文占用、继续对话 / 停止）
 * **留空不显示** —— 不置灰、不写占位；等它的接口补齐（M2）再往这里加，版式不用改。
 *
 * 两种来源：
 * - `via="task"`：这条任务是我们建的（`agentPath=autonomy`），按**我们的 taskId** 读
 *   `GET /api/tasks/{id}/executor`（控制面代理）；
 * - `via="executor"`：只在 autonomy 那边存在、我们没建过的行（对账 / 历史），按它的 id 读
 *   `GET /api/autonomy/tasks/{id}`。
 */
interface BodyProps {
  taskId: string;
  via?: "task" | "executor";
  /** 列表里那一行：描述 / 轮次先用它，免得首帧空窗。 */
  row?: TaskListRow;
  /** autonomy 自述（地址 / 版本）——只写进 chip 的悬停。 */
  meta?: AutonomyMeta | null;
  /** 变一下就立刻重读一次（投递了新指令时用；平时靠 5s 轮询）。 */
  reloadSignal?: number;
}

/** 详情轮询间隔（状态/进展会变；payload 很小）。 */
const REFRESH_MS = 5000;

export function ExecutorTaskBody({ taskId, via = "task", row, meta, reloadSignal = 0 }: BodyProps) {
  const [detail, setDetail] = useState<AutonomyTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(
        via === "task" ? await api.taskExecutor(taskId) : await api.autonomyTask(taskId),
      );
      setError(null);
    } catch (e) {
      setDetail(null);
      setError(errorText(e));
    }
  }, [taskId, via]);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

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
  const turns = row?.turns;
  const source = meta?.url
    ? `autonomy ${meta.url}${meta.version ? ` · v${meta.version}` : ""}`
    : undefined;

  return (
    <>
      {/* 四态条：主界面第一眼要看到的东西（依据也写在这一行里） */}
      <ExecutorPhaseBar detail={detail} loaded={detail !== null || error !== null} />

      <div className="task-ids task-status-bar" role="group" aria-label="执行方状态">
        {status ? (
          <span className={`auto-status ${statusClass(status)}`}>{status}</span>
        ) : null}
        {turns != null ? (
          <span className="task-id-chip is-static" title="autonomy 记的轮次（我们这边没有它的 runs）">
            <span className="task-id-label">轮次</span>
            <code className="task-id-value">{turns}</code>
          </span>
        ) : null}
        {row?.executorAgentId ? (
          <span className="task-id-chip is-static" title="执行方（autonomy）那侧的 agent id">
            <span className="task-id-label">执行 agent</span>
            <code className="task-id-value">{row.executorAgentId}</code>
          </span>
        ) : null}
        {updatedAt ? (
          <span className="task-id-chip is-static" title="执行方侧最后更新时间">
            <span className="task-id-label">更新于</span>
            <code className="task-id-value">{formatDateTime(updatedAt)}</code>
          </span>
        ) : null}
        {source ? (
          <span className="task-id-chip is-static" title="这两个字段的来处（控制面只代理）">
            <span className="task-id-label">数据源</span>
            <code className="task-id-value">{source}</code>
          </span>
        ) : null}
      </div>

      {/* 计划：正在规划 / 最新计划 + 已完成 step + 当前 step 的进展 */}
      <PlanSection detail={detail} status={status} />

      <div className="auto-detail">
        {error ? <div className="auto-banner bad">读执行方失败：{error}</div> : null}
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
        {detail ? (
          <details className="auto-raw">
            <summary>原始响应（排查用）</summary>
            <pre className="auto-pre">{JSON.stringify(detail, null, 2)}</pre>
          </details>
        ) : null}
      </div>

      {via === "executor" ? (
        /*
         * **对账行**（只在 autonomy 那边存在、我们没建过的任务）也能 chat：
         * 这个消息按**它那边的 task id** 投递（控制面只代理，我方库一行不写）。
         * 我们建的任务（via="task"）的输入框在详情底部（App 里），不在这里重复画。
         */
        <ExecutorChat
          key={taskId}
          via="executor"
          taskId={taskId}
          status={status}
          onDelivered={() => void load()}
        />
      ) : null}
    </>
  );
}

interface Props extends BodyProps {
  /** 这条 task 所属项目的组织（从我们自己的项目库取，和本地详情同一口径）。 */
  orgId?: string;
  orgName?: string;
}

/**
 * 只在 autonomy 那边存在、我们没建过的任务：与老任务同一个主区外壳（同一个 `TaskIdsBar`）。
 * 我们建的任务（`agentPath=autonomy`）走自己的任务详情，只把 `ExecutorTaskBody` 嵌进去。
 */
export default function AutonomyTaskPanel({ taskId, row, orgId, orgName, meta }: Props) {
  return (
    <>
      <TaskIdsBar
        task={{
          taskId,
          projectId: row?.projectId ?? "",
          agentId: row?.executorAgentId ?? row?.agentId ?? "",
        }}
        {...(orgId ? { orgId } : {})}
        {...(orgName ? { orgName } : {})}
        agentPath="autonomy"
      />
      <ExecutorTaskBody taskId={taskId} via="executor" {...(row ? { row } : {})} {...(meta ? { meta } : {})} />
    </>
  );
}
