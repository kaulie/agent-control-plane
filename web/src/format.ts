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

/**
 * `agent-1234abcd-5678-…` → `agent-1234abcd`（时间线 / Agent 看板共用同一个短号）。
 * Cline 的 `cls-…` id 不符合该 pattern，超长时退化为截断。
 */
export function shortAgentId(id: string): string {
  const m = id.match(/^(?:agent-)?([0-9a-f]{8})/i);
  if (m) return `agent-${m[1].toLowerCase()}`;
  return id.length > 20 ? `${id.slice(0, 20)}…` : id;
}
