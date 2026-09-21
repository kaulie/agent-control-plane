/**
 * task 的 **agent 创建路径**（`Task.agentPath`）。
 *
 * 任务只有一套（都是 web-cursor 的 task，落在我们库里）；区别是**这条 task 的 agent 是谁创建的**：
 *
 * - `control-plane`（默认，老行为）：控制面在本地 agent 工作区创建 agent 并执行；
 * - `autonomy`：**执行**交给 autonomy —— 任务仍由我们创建/落库，autonomy 的 runtime 创建 agent
 *   并执行；我们把执行方那侧的 task/agent id 记在自己的行上（`executorTaskId` / `executorAgentId`）。
 *
 * 与前端 `web/src/agent-path.ts` 同一套取值（那边负责显示文案）。
 */
export const AGENT_PATHS = ["control-plane", "autonomy"] as const;

export type AgentPath = (typeof AGENT_PATHS)[number];

/** 默认路径：控制面自己创建 agent（老行为）。 */
export const DEFAULT_AGENT_PATH: AgentPath = "control-plane";

export function isAgentPath(value: unknown): value is AgentPath {
  return (
    typeof value === "string" &&
    (AGENT_PATHS as readonly string[]).includes(value.trim())
  );
}

/** 归一化：非法 / 缺省 → 默认路径（老行为）。 */
export function normalizeAgentPath(value: unknown): AgentPath {
  return isAgentPath(value) ? value.trim() as AgentPath : DEFAULT_AGENT_PATH;
}
