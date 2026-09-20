/**
 * Agent 短号（看板 / 时间线共用）——把各家 SDK 的 agent id 归一化成**定宽**短号。
 *
 * 起因：同一个 task 的右下角小字会一会儿 8 位一会儿 20 位（前端去重规则只认
 * `agent-`），还会把**网关预分配**的占位 id 当成真的 Cursor 会话，看着有歧义。
 *
 * 规则（长度一律 14 字符 = 6 字符标签 + 8 位 hex）：
 * - `agent-<uuid>`（连线）    Cursor SDK 会话                → `agent-<8hex>`
 * - `cls-<hex>`               Cline SDK 会话                 → `cline-<8hex>`
 * - `agent-<16hex>`（无连线）  网关**预分配**、provider 还没建出会话的占位 id
 *                             （= 工作区目录名，见 `agentWorkspaceDirName`）
 *                                                            → `unset-<8hex>`
 * - 认不出的形状              截断成 13 字符 + `…`（同样 14 字符）
 *
 * 前端 `web/src/format.ts` 的 `shortAgentId` 是同一套规则，
 * `backend/scripts/test-agent-id-format.mjs` 用同一张用例表守住两边一致。
 */
export const AGENT_SHORT_WIDTH = 14;

/** 预分配占位：`newId("agent")` 的形状（`agent-` + 16 位 hex，**无连线**）。 */
const PREALLOCATED_RE = /^agent-([0-9a-f]{16})$/i;
/** 正常 SDK 会话：`agent-<uuid>`（Cursor）/ `cls-<hex>`（Cline）。 */
const SESSION_RE = /^(agent|cls)-([0-9a-f]{8})/i;

/** 6 字符标签（同宽），保证短号等宽、且不会把 Cline 会话写成 `agent-`。 */
function tagFor(prefix: string): string {
  return prefix.toLowerCase() === "cls" ? "cline" : "agent";
}

/**
 * `agent-7362ceb1-4b5b-…` → `agent-7362ceb1`；`cls-5f7393dd40a44b06` → `cline-5f7393dd`；
 * `agent-5f7393dd40a44b06`（预分配）→ `unset-5f7393dd`。定宽 14 字符。
 */
export function agentDisplayName(agentId: string): string {
  const raw = (agentId ?? "").trim();
  const pre = PREALLOCATED_RE.exec(raw);
  if (pre) return `unset-${pre[1].slice(0, 8).toLowerCase()}`;
  const m = SESSION_RE.exec(raw);
  if (m) return `${tagFor(m[1])}-${m[2].toLowerCase()}`;
  return raw.length > AGENT_SHORT_WIDTH
    ? `${raw.slice(0, AGENT_SHORT_WIDTH - 1)}…`
    : raw;
}
