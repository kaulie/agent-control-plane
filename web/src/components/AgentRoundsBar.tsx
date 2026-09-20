import type { RunRecord } from "../types";
import { shortAgentId } from "../format";
import {
  currentAgentRounds,
  resolveCurrentAgentId,
  roundsLabel,
  roundsTitle,
} from "../agent-rounds";

interface Props {
  /** 当前 task 的 run 记录（`GET /api/tasks/:id` 的 `runs`）。 */
  runs: RunRecord[];
  /** task 当前绑定的 agent 实例 id（老任务可能没有）。 */
  agentId?: string;
}

/**
 * 主界面顶部常驻的一条：**当前 agent 已经执行的轮次**。
 *
 * 「当前 agent」= 选中 task 当前绑定的 agent 实例（不是整条 task 的累计 —— 那会跨
 * succession 换过的所有 agent）。数字直接从 task 的 runs 里按 `agentId` 统计得到，
 * 纯展示、不触发任何写操作。没有 agent 实例（老任务）时整条不渲染。
 */
export default function AgentRoundsBar({ runs, agentId }: Props) {
  const agent = resolveCurrentAgentId(agentId, runs);
  if (!agent) return null;
  const rounds = currentAgentRounds(runs, agent);
  return (
    <div
      className="agent-rounds"
      role="group"
      aria-label="当前 agent 已执行的轮次"
    >
      <span
        className="agent-rounds-chip"
        title={`${roundsLabel(rounds)}\n${roundsTitle(rounds)}`}
        data-agent-id={agent}
      >
        <span className="agent-rounds-label">当前 agent 已执行</span>
        <span className="agent-rounds-count">{rounds.executed}</span>
        <span className="agent-rounds-unit">轮</span>
        <span className="agent-rounds-agent">{shortAgentId(agent)}</span>
      </span>
      <span className="agent-rounds-hint">
        完成 {rounds.finished} · 在跑 {rounds.running}
        {rounds.failed ? ` · 出错/取消 ${rounds.failed}` : ""}
        {rounds.queued ? ` · 排队 ${rounds.queued}` : ""}
      </span>
    </div>
  );
}
