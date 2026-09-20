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
 *
 * seed 有硬性契约（2026-09-20 线上事故的教训，见 `isRealUserTurn`）：
 * 1. 第一条必须是**真实用户发言**（不是工具结果、不是 assistant）；
 * 2. 每个 `tool_use` 都要有配对的 `tool_result`，反之亦然。
 * 违反契约的 seed 会被上游直接 400（DeepSeek：`Messages with role 'tool' must be a
 * response to a preceding message with 'tool_calls'`），而且**失败后那个会话是坏的**：
 * 非法历史留在驻留会话里，之后每条消息都秒失败（task-48cc978355744c55 与
 * task-701ab0bbdd5d45fd 都被这样卡死过）。所以 `sanitizeSeedHistory()` 必须跑在 seed 之前。
 */
import type { MessageWithMetadata } from "@cline/sdk";
import { estimateMessagesTokenRange, messageChars } from "../../context/index.js";

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
  /**
   * seed 的**硬**上限（tokens，保守口径 = 3 字符/token）；<= 0 / 未给 = 不检查。
   *
   * 为什么需要它：字符预算是「花多少钱」的软目标，模型窗口才是硬约束。起点必须对齐到
   * turn 边界（见 `trimSeedHistory`），而一个 turn 可能很长（实测：147 条里只有 2 条真实
   * 用户发言，整段 287K 字符），所以对齐后**可能远超** `maxChars`。那种情况下宁可放弃
   * 续接（退化成只注简报），也不要喂一个一出生就超窗口的历史 —— 那又是一次必然的 400。
   */
  maxSeedTokens?: number;
}

/** 为什么没续接上（都会退化回老行为：只注简报 + `session_reset`）。 */
export type RestartResumeSkipReason =
  | "disabled"
  | "no_previous_agent"
  | "unknown_session"
  | "workspace_mismatch"
  | "empty_history"
  | "over_window"
  | "error";

export interface RestartResumeResult {
  /** 准备喂给 `start({ initialMessages })` 的历史（已裁到预算内、已修好工具契约，可能为空）。 */
  messages: MessageWithMetadata[];
  /** 因预算被丢掉的消息条数。 */
  droppedMessages: number;
  /** 保留下来的字符数。 */
  chars: number;
  /** 为满足工具调用契约被剔掉的失配工具块数（`tool_use` 没结果 / 结果没调用）。 */
  droppedToolBlocks?: number;
  /** 上面那种剔除（或开头不是真实用户发言）导致**整条**丢掉的消息数。 */
  droppedSeedMessages?: number;
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
 * 消息的内容块（只声明我们真正要看的字段；这里不 import SDK 内部类型，
 * 保持本模块的纯逻辑可测性 —— 单测可以直接喂假对象）。
 */
interface SeedBlock {
  type?: string;
  /** `tool_use` 的 id。 */
  id?: string;
  /** `tool_result` 指向的 `tool_use` id。 */
  tool_use_id?: string;
}

function contentOf(message: MessageWithMetadata): unknown {
  return (message as { content?: unknown }).content;
}

function blocksOf(message: MessageWithMetadata): SeedBlock[] {
  const content = contentOf(message);
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is SeedBlock => Boolean(block) && typeof block === "object",
  );
}

/**
 * **真正的用户发言** = role 是 user，而且不是「只有工具结果」的那种 user。
 *
 * 为什么不能只看 role（2026-09-20 线上事故的根因）：cline 的 transcript 把**工具结果也
 * 记成 `role: "user"`**（`content: [{ type: "tool_result", tool_use_id }]`），
 * `tool_use` 在它上一条 assistant 消息里。只按 role 判断的话，尾部裁剪的起点可能
 * 正好落在一条工具结果上，seed 的第一条就成了 tool_result；上游按 OpenAI 风格把它翻成
 * `role: "tool"`，前面却没有带 `tool_calls` 的 assistant —— DeepSeek 直接 400：
 * `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。
 *
 * 实测（~/.cline/data/sessions/agent-10d2a0eaa22244d1/*.messages.json）：147 条里
 * 「按预算丢最旧 92 条」后 seed 的第一条正是 `user [tool_result]`，新会话（cls-4bc71ba2…）
 * 的落盘历史第一条同样是 `user [tool_result]` —— 之后这个会话又原样失败了第二次。
 */
export function isRealUserTurn(message: MessageWithMetadata): boolean {
  if (!isUserMessage(message)) return false;
  const content = contentOf(message);
  if (typeof content === "string") return content.trim().length > 0;
  const blocks = blocksOf(message);
  if (!blocks.length) return false;
  return blocks.some((block) => block.type !== "tool_result");
}

export interface SeedSanitizeResult {
  messages: MessageWithMetadata[];
  /** 被整条丢掉的消息数（失配工具块被剔空、开头不是真实用户发言的段落）。 */
  droppedMessages: number;
  /** 被剔掉的失配工具块数。 */
  droppedToolBlocks: number;
}

/**
 * 把 seed 修成「provider 一定收」的样子：
 *
 * 1. **工具配对**：`tool_use` 必须有配对的 `tool_result`，`tool_result` 也必须有配对的
 *    `tool_use`（只在**这段 seed 内**配对 —— 被预算裁掉的对端就等于没有）。失配的块直接
 *    剔掉，块被剔空的消息整条丢掉。
 * 2. **首条是真实用户发言**：前面那些 assistant / 工具结果（配对坏了、或者语义上不该
 *    开头）统统丢掉，让模型看到的是「用户先开口」。
 * 3. 修完什么都不剩 → 返回空，调用方退化成「只注启动简报」（宁可少上下文，也不要
 *    一个必然 400 的 seed —— 400 会把会话永久卡死）。
 *
 * 与 SDK 自带 `sanitizeImportedMessages()` 的关系：那个函数是给**整段外来会话**用的，
 * 对孤儿 `tool_use` 会**伪造**一条 `[import] Tool result was not captured…` 占位结果。
 * 续接 seed 是「自己会话的尾巴」，伪造工具结果会污染上下文（模型会当成真结果），
 * 所以我们只做剔除，不伪造；另外它也**不保证**首条是用户发言。
 */
export function sanitizeSeedHistory(
  messages: readonly MessageWithMetadata[],
): SeedSanitizeResult {
  if (!messages.length) return { messages: [], droppedMessages: 0, droppedToolBlocks: 0 };

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block.type === "tool_use" && typeof block.id === "string" && block.id) {
        toolUseIds.add(block.id);
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.tool_use_id
      ) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  let droppedToolBlocks = 0;
  const paired: MessageWithMetadata[] = [];
  for (const message of messages) {
    const content = contentOf(message);
    if (!Array.isArray(content)) {
      paired.push(message);
      continue;
    }
    const kept = content.filter((raw) => {
      const block = (raw ?? {}) as SeedBlock;
      if (block.type === "tool_use") {
        return typeof block.id === "string" && toolResultIds.has(block.id);
      }
      if (block.type === "tool_result") {
        return typeof block.tool_use_id === "string" && toolUseIds.has(block.tool_use_id);
      }
      return true;
    });
    droppedToolBlocks += content.length - kept.length;
    if (!kept.length) continue;
    paired.push({ ...(message as object), content: kept } as MessageWithMetadata);
  }

  let start = 0;
  while (start < paired.length && !isRealUserTurn(paired[start])) start += 1;
  if (start >= paired.length) {
    return { messages: [], droppedMessages: messages.length, droppedToolBlocks };
  }
  const kept = paired.slice(start);
  return {
    messages: [...kept],
    droppedMessages: messages.length - kept.length,
    droppedToolBlocks,
  };
}

/**
 * 裁剪 seed 历史：**从最新往回装**（尾部优先，最近的上下文最值钱），并要求
 * 保留段的**第一条是真实用户发言** —— 否则模型/provider 会看到「assistant 先开口」
 * 或者（更糟）「工具结果先开口」的历史，两边都不认这种截断。
 *
 * 两个刻意的取舍：
 * - 最新那条消息无论多大都保留（不然等于没续接）；
 * - 需要对齐到 user 时，**宁可略微超预算**多带一条 user 消息，也不要退化成
 *   「一条都不 seed」（预算默认 60K 字符，正常会话碰不到这个边角）。
 *
 * 注意：这里只做「预算 + 起点对齐」；工具调用的配对由 `sanitizeSeedHistory()` 保证。
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

  if (start < messages.length && !isRealUserTurn(messages[start])) {
    let prevUser = -1;
    for (let i = start - 1; i >= 0; i -= 1) {
      if (isRealUserTurn(messages[i])) {
        prevUser = i;
        break;
      }
    }
    // 前面还有 user 就带上它（保「首条是 user」）；一条都没有就保持现状，交给
    // sanitizeSeedHistory 判定（它会退化成空 → 只注简报）。
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
    // 裁完必须过一遍工具契约（见 sanitizeSeedHistory 的注释）：seed 里出现孤立的
    // tool_result（或孤立的 tool_use）会被上游 400，而且那个会话之后就永久卡死。
    const clean = sanitizeSeedHistory(trimmed.messages);
    if (!clean.messages.length) return empty("empty_history");
    // 硬约束：种子连模型窗口都装不下就放弃（见 maxSeedTokens 的说明）。
    const maxSeedTokens = opts.maxSeedTokens ?? 0;
    if (maxSeedTokens > 0) {
      const range = estimateMessagesTokenRange(clean.messages);
      if (range.tokensUpperBound > maxSeedTokens) return empty("over_window");
    }
    return {
      messages: clean.messages,
      droppedMessages: trimmed.droppedMessages,
      chars: clean.messages.reduce((sum, message) => sum + messageChars(message), 0),
      ...(clean.droppedToolBlocks > 0 ? { droppedToolBlocks: clean.droppedToolBlocks } : {}),
      ...(clean.droppedMessages > 0 ? { droppedSeedMessages: clean.droppedMessages } : {}),
    };
  } catch (err) {
    return empty("error", err instanceof Error ? err.message : String(err));
  }
}
