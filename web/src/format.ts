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
