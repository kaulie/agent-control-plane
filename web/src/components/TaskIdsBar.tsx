import { useEffect, useRef, useState } from "react";
import AgentPathChip from "./AgentPathChip";
import type { AgentPath, Task } from "../types";

/**
 * 一条基础信息（方便测试用）：
 * - `value` 是**真实 id**（点一下就能复制到剪贴板，去 curl / 查库用）；
 * - `hint` 是这个名字对应的中文口径（Task / Project / Org …），鼠标悬停能看到；
 * - `missing` = 这个 id 现在拿不到（例如项目没设部门 → 没有组织 id），只显示占位文案，不给复制。
 */
export interface TaskIdRow {
  key: "task" | "project" | "org" | "agent";
  label: string;
  value: string;
  /** 悬停说明（写清这个 id 是干什么用的 / 从哪来）。 */
  hint: string;
  missing?: boolean;
}

/** 项目没设部门时的组织占位文案（**不是**一个可复制的 id）。 */
export const NO_ORG_PLACEHOLDER = "未设置组织";

/**
 * 组装「任务基础信息」的行（纯函数，方便单测）：
 *
 * - `task`：task id（任务的唯一标识，事件 / 运行记录都挂在它上面）；
 * - `project`：task 所属 project id；
 * - `org`：**注入 agent 简报复用的组织 id** —— 来自 `project.department.departmentId`
 *   （服务清单就是按它查 `GET /v1/orgs/{orgId}/services`），项目没设部门时显示占位；
 * - `agent`：当前绑定的 agent id（查时间线 / 看板用），老任务可能还没有。
 */
export function taskIdRows(
  task: Pick<Task, "taskId" | "projectId" | "agentId">,
  opts: { orgId?: string; orgName?: string } = {},
): TaskIdRow[] {
  const orgId = opts.orgId?.trim() ?? "";
  const rows: TaskIdRow[] = [
    {
      key: "task",
      label: "Task",
      value: task.taskId,
      hint: "任务 id：事件流 / 运行记录 / 时间线都挂在它上面",
    },
    {
      key: "project",
      label: "Project",
      value: task.projectId,
      hint: "所属项目 id（侧边栏那个项目）",
    },
    {
      key: "org",
      label: "Org",
      value: orgId || NO_ORG_PLACEHOLDER,
      hint: orgId
        ? `组织 id（= project.department.departmentId，注入 agent 的仓库地址按它查服务中心${
            opts.orgName ? `：${opts.orgName}` : ""
          }）`
        : "这个项目还没设部门 → 没有组织 id，agent 简报里也就拿不到服务仓库清单",
      ...(orgId ? {} : { missing: true }),
    },
  ];
  const agentId = task.agentId?.trim() ?? "";
  if (agentId) {
    rows.push({
      key: "agent",
      label: "Agent",
      value: agentId,
      hint: "当前绑定的 agent 实例 id（agent 看板 / 时间线用）",
    });
  }
  return rows;
}

interface Props {
  /**
   * 只要那三个 id：本地任务传整个 `Task` 即可；agent 由 autonomy 创建的任务
   * 只有 id 可从它的接口拿到，就传 `{ taskId, projectId, agentId }`（别的字段它没有）。
   */
  task: Pick<Task, "taskId" | "projectId" | "agentId">;
  /** 这个 task 所属项目的组织 id（= `project.department.departmentId`）。 */
  orgId?: string;
  /** 组织名快照，仅为了让悬停提示更好读。 */
  orgName?: string;
  /** 这条 task 的 agent 是谁创建的（老任务 = 控制面；新入口 = autonomy）。 */
  agentPath?: AgentPath;
  /** autonomy 侧的数据源（只写进悬停；拿不到就不传 —— 留空不显示）。 */
  agentPathSource?: string;
}

const COPIED_MS = 1200;

/** 复制到剪贴板：权限 / 非安全上下文下可能不可用，失败就静默（不影响看 id）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 任务详情页顶部常驻的一条「基础信息」：Task / Project / Org（+ Agent）。
 *
 * 目的很单纯：**方便测试**——不用去猜 / 去翻接口，页面上直接能看到 taskId、
 * projectId、orgId（组织 id），点一下即可复制。纯展示，不触发任何写操作。
 */
export default function TaskIdsBar({
  task,
  orgId,
  orgName,
  agentPath,
  agentPathSource,
}: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const rows = taskIdRows(task, { ...(orgId ? { orgId } : {}), ...(orgName ? { orgName } : {}) });

  const onCopy = async (row: TaskIdRow): Promise<void> => {
    if (row.missing) return;
    if (!(await copyText(row.value))) return;
    setCopied(row.key);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(null), COPIED_MS);
  };

  return (
    <div className="task-ids" role="group" aria-label="任务基础信息（Task / Project / Org / Agent id）">
      {rows.map((row) =>
        row.missing ? (
          <span
            key={row.key}
            className="task-id-chip is-missing"
            title={row.hint}
          >
            <span className="task-id-label">{row.label}</span>
            <span className="task-id-value">{row.value}</span>
          </span>
        ) : (
          <button
            key={row.key}
            type="button"
            className={`task-id-chip${copied === row.key ? " copied" : ""}`}
            title={`${row.hint}\n点一下复制：${row.value}`}
            onClick={() => void onCopy(row)}
          >
            <span className="task-id-label">{row.label}</span>
            <code className="task-id-value">{row.value}</code>
            <span className="task-id-copied">
              {copied === row.key ? "已复制" : "复制"}
            </span>
          </button>
        ),
      )}
      {/* agent 创建路径和 id 放在同一行 chip 里：两条路径对称，才是「字段」而不是特例标记。 */}
      {agentPath ? (
        <AgentPathChip
          path={agentPath}
          {...(agentPathSource ? { source: agentPathSource } : {})}
        />
      ) : null}
    </div>
  );
}
