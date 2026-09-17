/**
 * Agent 看板上的两处「数字口径」文案（纯函数，便于测试）。
 *
 * 为什么要专门写这两行：同一个 task 会因 succession（模式切换 / 会话不可用）换过
 * 多个 agent，而每个 agent 只拥有自己那些 run。于是看板上一行 per-agent 的
 * 「累计完成对话轮次 / token / 时长」会比这个 task 的真实工作量小很多 ——
 * 光看一行会以为「数据不对」。所以：
 *   - 每行的轮次列额外标出**整条 task 的累计**（`taskRollupText`）；
 *   - tooltip 里把两个口径都写清楚（`roundsTitle`）。
 */
import type { AgentBoardRow } from "./types";

/** task 累计那一小行；task 只有一个 agent 时不需要（两行数字一样，只是噪音）。 */
export function taskRollupText(row: AgentBoardRow): string | null {
  if (row.taskScope) return null;
  const totals = row.taskTotals;
  if (!totals || totals.agentCount <= 1) return null;
  return `task 累计 ${totals.completedRounds} 轮（${totals.agentCount} 个 agent）`;
}

/**
 * 「累计完成对话轮次」列的 tooltip：per-agent 的数字 + 整条 task 的累计。
 */
export function roundsTitle(row: AgentBoardRow): string {
  const lines = [
    row.taskScope
      ? `整个 task 累计完成 ${row.completedRounds} 轮（status = finished）`
      : `这个 agent 完成 ${row.completedRounds} 轮（status = finished）`,
    `共 ${row.runCount} 次 run（含取消 / 出错 / 进行中）`,
  ];
  if (!row.taskScope && row.taskTotals && row.taskTotals.agentCount > 1) {
    lines.push(
      `task 累计：${row.taskTotals.completedRounds} 轮 / ${row.taskTotals.runCount} runs`,
      `这个 task 换过 ${row.taskTotals.agentCount} 个 agent 实例，每个 agent 只算自己的 run`,
    );
  }
  return lines.join("\n");
}
