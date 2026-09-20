import type { RunRecord } from "./types";

/**
 * 「当前 agent 已执行的轮次」口径（主界面用）。
 *
 * 轮次 = 一轮 run。一个 task 因 succession（模式切换 / 会话不可用）可能换过多个
 * agent 实例，每个 run 都带 `agentId`。主界面要看的是**当前绑定的那个 agent** 自己
 * 跑过的轮次，而不是整条 task 累计（task 累计可能跨好几个 agent）。
 *
 * 「已执行」= 真正开始跑过的轮次：`queued`（还在排队、一次都没跑）不算；
 * `finished` / `running` / `error` / `cancelled` 都算跑过。
 */
export interface CurrentAgentRounds {
  /** 这些数字归属的 agent 实例 id。 */
  agentId: string;
  /** 该 agent 的 run 总数（含还在排队的 queued）。 */
  total: number;
  /** 已执行的轮次：`status !== "queued"`。 */
  executed: number;
  /** 正常跑完的轮次（`status === "finished"`）。 */
  finished: number;
  /** 正在跑的轮次（`status === "running"`）。 */
  running: number;
  /** 出错 / 取消的轮次（`error` / `cancelled`）。 */
  failed: number;
  /** 还在排队、尚未执行的轮次（`status === "queued"`）。 */
  queued: number;
}

type RunLike = Pick<RunRecord, "agentId" | "status">;

/**
 * 选中 task 的「当前 agent」：
 * - 优先用 task 自己绑定的 `agentId`；
 * - 老任务没有 `agentId` 时，退回**最后一轮 run** 的 agent（历史数据兼容）；
 * - 都没有 → 空串（主界面据此不渲染这一条）。
 */
export function resolveCurrentAgentId(
  taskAgentId: string | undefined,
  runs: ReadonlyArray<Pick<RunRecord, "agentId">>,
): string {
  const bound = taskAgentId?.trim();
  if (bound) return bound;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const id = runs[i]?.agentId?.trim();
    if (id) return id;
  }
  return "";
}

/** 统计某个 agent 自己已执行 / 完成 / 排队等的轮次（纯函数，方便单测）。 */
export function currentAgentRounds(
  runs: ReadonlyArray<RunLike>,
  agentId: string,
): CurrentAgentRounds {
  const id = agentId.trim();
  let total = 0;
  let finished = 0;
  let running = 0;
  let failed = 0;
  let queued = 0;
  for (const run of runs) {
    if (run.agentId !== id) continue;
    total += 1;
    switch (run.status) {
      case "finished":
        finished += 1;
        break;
      case "running":
        running += 1;
        break;
      case "queued":
        queued += 1;
        break;
      default:
        // error / cancelled —— 跑过但没成功。
        failed += 1;
        break;
    }
  }
  return {
    agentId: id,
    total,
    executed: finished + running + failed,
    finished,
    running,
    failed,
    queued,
  };
}

/** 主界面那枚 chip 上的主文案，例如 `已执行 12 轮`。 */
export function roundsLabel(rounds: CurrentAgentRounds): string {
  return `已执行 ${rounds.executed} 轮`;
}

/**
 * chip 的悬停说明：写清口径（这是**当前 agent 自己**的轮次）+ 明细，
 * 免得又跟「task 累计」混淆（那会跨这个 task 历史上所有 agent）。
 */
export function roundsTitle(rounds: CurrentAgentRounds): string {
  const lines = [
    `当前 agent（${rounds.agentId}）自己跑过的轮次：${rounds.executed} 轮`,
    "一轮 = 一次 run；已执行 = 真正跑过（不含还在排队的 queued）",
    `完成 ${rounds.finished} · 正在跑 ${rounds.running} · 出错/取消 ${rounds.failed}` +
      (rounds.queued ? ` · 排队 ${rounds.queued}` : ""),
    "只统计这个 agent 实例；task 累计会跨它历史上换过的所有 agent",
  ];
  return lines.join("\n");
}
