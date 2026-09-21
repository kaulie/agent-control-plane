import type { AgentPath } from "./types";

/**
 * task 的 agent **创建路径**的显示口径（列表行 / 详情里都用它，避免各处自造词）。
 *
 * 任务只有一套（都是 web-cursor 的任务）；两条路径的差别是**谁创建了这个 agent**：
 * 控制面在本地工作区创建，或 autonomy 的 runtime 创建。
 */
export const AGENT_PATH_LABEL: Record<AgentPath, string> = {
  "control-plane": "控制面",
  autonomy: "autonomy",
};

export const AGENT_PATH_HINT: Record<AgentPath, string> = {
  "control-plane":
    "agent 由控制面创建：在本地 agent 工作区里执行（现状路径）",
  autonomy:
    "agent 由 autonomy 创建：由它的 runtime 执行；控制面只代理它的状态与进展，不落库",
};

/** 列表行 / chip 上的短名。 */
export function agentPathLabel(path: AgentPath): string {
  return AGENT_PATH_LABEL[path] ?? path;
}

export function agentPathHint(path: AgentPath): string {
  return AGENT_PATH_HINT[path] ?? "";
}
