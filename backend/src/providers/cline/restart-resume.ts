/**
 * 网关重启后的会话续接（透明化 PR-6，见 `backend/src/context/README.md`）。
 *
 * 问题：cline 的会话 runtime **只活在本进程内存**（`ClineCore.create({ backendMode: "local" })`
 * → `runTurn` 走 `getSessionOrThrow`），网关一重启，`sessionsByTask` 就空了。以前的处理是
 * 「注一份启动简报 + 从头开始」，时间线上写「会话已重置」—— 用户看到的是 agent 突然失忆。
 *
 * 事实：SDK 把每个会话的清单 + 完整消息**落盘**在 `~/.cline/data/sessions/<sessionId>/`
 * （`<id>.json` + `<id>.messages.json`，索引在 `~/.cline/data/db/sessions.db`），
 * 并且 `readLiveMessages()` 在会话不驻留时会**自动回落到磁盘 transcript**。
 *
 * 所以正确的「恢复」姿势是 SDK 官方那套：读回磁盘历史 → 裁到预算 → 用它 seed 一个新会话
 * （`start({ initialMessages })`），这也是本模块做的事。
 *
 * 边界（都已核对 SDK 源码，别想当然）：
 * - local 模式**不能**原地复活旧 session（非驻留 → `session_not_found`），
 *   所以续接语义是「新 session id + 旧 transcript」，不是同一个 id 复活；
 * - 磁盘 transcript 只在 assistant / turn 边界落盘，重启发生在 turn 中途时最后一段可能缺失；
 * - **只认 cwd 与当前 task 工作区一致的会话**，绝不跨任务借历史。
 */
import type { MessageWithMetadata } from "@cline/sdk";
import { messageChars } from "../../context/index.js";

/** 只依赖两个 SDK 调用，便于单测注入假实现。 */
export interface RestartHistoryDeps {
  /** `cline.get(sessionId)`：拿 cwd（工作区守卫用）；会话不存在时返回 undefined。 */
  getSession: (sessionId: string) => Promise<{ cwd?: string; status?: string } | undefined>;
  /** `cline.readLiveMessages(sessionId)`：不驻留时自动回落磁盘 transcript。 */
  readMessages: (sessionId: string) => Promise<MessageWithMetadata[] | undefined>;
}

export interface RestartResumeOptions {
  /** 任务上绑的旧会话 id（= `task.agentId`）。空 = 新任务/预分配，直接跳过。 */
  previousAgentId?: string;
  /** 当前 task 的工作区（= run 的 cwd）；用来防止跨任务借历史。 */
  cwd: string;
  /** 总开关（`CLINE_RESUME_SEED=0` 关）。 */
  enabled: boolean;
  /** seed 的字符预算（`CLINE_RESUME_SEED_CHARS`）；<= 0 视为关闭。 */
  maxChars: number;
}

/** 为什么没续接上（都会退化回老行为：只注简报 + `session_reset`）。 */
export type RestartResumeSkipReason =
  | "disabled"
  | "no_previous_agent"
  | "unknown_session"
  | "workspace_mismatch"
  | "empty_history"
  | "error";

export interface RestartResumeResult {
  /** 准备喂给 `start({ initialMessages })` 的历史（已裁到预算内，可能为空）。 */
  messages: MessageWithMetadata[];
  /** 因预算被丢掉的消息条数。 */
  droppedMessages: number;
  /** 保留下来的字符数。 */
  chars: number;
  /** 跳过的原因；`messages` 非空时不存在。 */
  skipped?: RestartResumeSkipReason;
  error?: string;
}

const SEP = /\/+$/;

/**
 * 续接 seed 的默认字符预算：60000 字符 ≈ 9.4k tokens（实测口径 6.4 字符/token）。
 * 参考体量：一次 run 的磁盘 transcript 270KB ≈ 58.6k tokens，全量 seed 太贵。
 */
export const DEFAULT_RESUME_SEED_CHARS = 60_000;

/** 路径比较：只做「同一条路径」的朴素判定（去掉尾部斜杠）。 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.trim().replace(SEP, "");
  const left = norm(a);
  const right = norm(b);
  return left.length > 0 && left === right;
}

function isUserMessage(message: MessageWithMetadata): boolean {
  return String((message as { role?: unknown }).role ?? "") === "user";
}

/**
 * 裁剪 seed 历史：**从最新往回装**（尾部优先，最近的上下文最值钱），并要求
 * 保留段的**第一条是 user** —— 否则模型/provider 会看到「assistant 先开口」的历史，
 * 两边都不认这种截断。
 *
 * 两个刻意的取舍：
 * - 最新那条消息无论多大都保留（不然等于没续接）；
 * - 需要对齐到 user 时，**宁可略微超预算**多带一条 user 消息，也不要退化成
 *   「一条都不 seed」（预算默认 60K 字符，正常会话碰不到这个边角）。
 */
export function trimSeedHistory(
  messages: readonly MessageWithMetadata[],
  maxChars: number,
): { messages: MessageWithMetadata[]; droppedMessages: number; chars: number } {
  if (!messages.length) return { messages: [], droppedMessages: 0, chars: 0 };
  if (!(maxChars > 0)) return { messages: [], droppedMessages: messages.length, chars: 0 };

  let start = messages.length;
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = messageChars(messages[i]);
    if (start < messages.length && chars + cost > maxChars) break;
    chars += cost;
    start = i;
  }

  if (start < messages.length && !isUserMessage(messages[start])) {
    let prevUser = -1;
    for (let i = start - 1; i >= 0; i -= 1) {
      if (isUserMessage(messages[i])) {
        prevUser = i;
        break;
      }
    }
    // 前面还有 user 就带上它（保「首条是 user」）；一条都没有就保持现状，别清空。
    if (prevUser >= 0) start = prevUser;
  }

  const kept = messages.slice(start);
  return {
    messages: [...kept],
    droppedMessages: start,
    chars: kept.reduce((sum, message) => sum + messageChars(message), 0),
  };
}

/**
 * 从磁盘捞回旧会话的历史。安全第一：任何一步不满足（开关关、没有旧 id、
 * 会话不在索引里、cwd 不是这个 task 的工作区、磁盘上没有消息）都返回空 + `skipped`，
 * 由调用方退化回「只注简报」。
 */
export async function recoverSessionAfterRestart(
  deps: RestartHistoryDeps,
  opts: RestartResumeOptions,
): Promise<RestartResumeResult> {
  const empty = (skipped: RestartResumeSkipReason, error?: string): RestartResumeResult => ({
    messages: [],
    droppedMessages: 0,
    chars: 0,
    skipped,
    ...(error ? { error } : {}),
  });

  if (!opts.enabled || !(opts.maxChars > 0)) return empty("disabled");
  const previousAgentId = opts.previousAgentId?.trim() ?? "";
  if (!previousAgentId) return empty("no_previous_agent");

  try {
    const session = await deps.getSession(previousAgentId);
    if (!session) return empty("unknown_session");
    const sessionCwd = session.cwd?.trim() ?? "";
    if (!sessionCwd || !samePath(sessionCwd, opts.cwd)) return empty("workspace_mismatch");

    const raw = (await deps.readMessages(previousAgentId)) ?? [];
    if (!raw.length) return empty("empty_history");

    const trimmed = trimSeedHistory(raw, opts.maxChars);
    if (!trimmed.messages.length) return empty("empty_history");
    return trimmed;
  } catch (err) {
    return empty("error", err instanceof Error ? err.message : String(err));
  }
}
