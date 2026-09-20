export function formatTokens(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

/** 币种符号（不认识就退回 3 位代码 + 空格，例如 `CHF 12.30`）。 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  RMB: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

/**
 * 本币金额（元 / 不带「分」）→ 文本。计费表算出来的钱是本币，别再当美元显示。
 * 极小金额（< 0.01）保留 4 位，免得单轮成本显示成 `¥0.00`。
 */
export function formatMoney(
  amount: number | undefined | null,
  currency?: string | null,
): string {
  const code = (currency || "USD").trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const prefix = symbol ?? `${code} `;
  if (amount == null || Number.isNaN(amount)) return `${prefix}0.00`;
  const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  return `${prefix}${amount.toFixed(digits)}`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "0秒";
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return "0秒";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分钟`);
  if (s > 0 || parts.length === 0) parts.push(`${s}秒`);
  return parts.join("");
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Sidebar / list timestamps: date + time (no seconds). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

export function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Agent 短号定宽：14 字符（6 字符标签 + 8 位 hex），认不出的形状也截成等宽。 */
export const AGENT_SHORT_WIDTH = 14;

/**
 * Agent 短号（时间线右下角小字 / Agent 看板 / 轮次条共用），**定宽 14 字符**：
 *
 * - `agent-1234abcd-5678-…`（Cursor 会话，带连线的 uuid）→ `agent-1234abcd`
 * - `cls-5f7393dd40a44b06`（Cline 会话）→ `cline-5f7393dd`
 * - `agent-5f7393dd40a44b06`（无连线的 16 位 hex = 网关**预分配**、provider 还没建出
 *   会话的占位 id，就是工作区目录名）→ `unset-5f7393dd`
 * - 其它形状 → 前 13 字符 + `…`（同样 14 字符）
 *
 * 以前只认 `agent-`：Cline 的 id 会原样打出 20 字符、预分配的占位 id 又假装成
 * Cursor 会话，一行里长短不一还有歧义。
 *
 * 与后端 `backend/src/agent-id.ts` 的 `agentDisplayName` 是同一套规则，
 * `backend/scripts/test-agent-id-format.mjs` 用同一张用例表守住两边一致。
 */
export function shortAgentId(id: string): string {
  const raw = (id ?? "").trim();
  // 预分配占位：agent- + 紧接 16 位 hex（无连线）→ 还不是活会话。
  const pre = /^agent-([0-9a-f]{16})$/i.exec(raw);
  if (pre) return `unset-${pre[1].slice(0, 8).toLowerCase()}`;
  const m = /^(agent|cls)-([0-9a-f]{8})/i.exec(raw);
  if (m) return `${m[1].toLowerCase() === "cls" ? "cline" : "agent"}-${m[2].toLowerCase()}`;
  return raw.length > AGENT_SHORT_WIDTH
    ? `${raw.slice(0, AGENT_SHORT_WIDTH - 1)}…`
    : raw;
}
