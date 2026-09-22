/**
 * Provider + 账号池。
 *
 * 一个账号 = **运行时 provider + vendor + 这一把 key**，不是「整个 cursor / 整个 cline
 * 共用一把」。例如：
 * - `cursor` + `cursor` + keyA / keyB → 两个 Cursor 账号，可同时存在、轮换使用；
 * - `cline` + `deepseek` + key1 / key2 → 两个 DeepSeek 账号；
 * - `cline` + `minimax` + key3 → 又一个 MiniMax 账号。
 *
 * API key 只存在 SQLite，不再读 `CURSOR_API_KEY` / `DEEPSEEK_API_KEY` 来决定
 * 这次 run 用谁。列表接口只回掩码，完整 key 不出网。
 */

import path from "node:path";
import { Llms } from "@cline/sdk";

export type AccountProvider = "cursor" | "cline";

/** Cursor 没有二级 vendor；Cline 的 vendor = LLM 厂商标识（deepseek / minimax / …）。 */
export const CURSOR_VENDOR = "cursor";

export const FALLBACK_CLINE_VENDORS = [
  "deepseek",
  "minimax",
  "anthropic",
  "openai",
  "openai-compatible",
] as const;

export interface ProviderAccount {
  accountId: string;
  /** Agent 运行时：`cursor` | `cline`。 */
  provider: AccountProvider;
  /**
   * 账号所属的模型厂。Cursor 固定 `cursor`；Cline 是 `deepseek` / `minimax` 等
   * （`Llms.getProviderIds()`）。
   */
  vendor: string;
  label: string;
  apiKeyMasked: string;
  /** 可选：OpenAI-compatible / 自建网关。 */
  baseUrl?: string;
  /** 该账号下新 agent 的工作区根：cwd = `{root}/{agentId}`。 */
  agentRootWorkspace: string;
  enabled: boolean;
  /** 同一 `(provider, vendor)` 最多一个默认账号。 */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 仅内部使用：带完整 key。绝不进 HTTP 响应。 */
export interface ProviderAccountSecret extends ProviderAccount {
  apiKey: string;
}

export interface ProviderAccountInput {
  provider: string;
  vendor?: string;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  agentRootWorkspace: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export function isAccountProvider(value: unknown): value is AccountProvider {
  return value === "cursor" || value === "cline";
}

export function normalizeVendor(
  provider: AccountProvider,
  vendor: string | undefined,
): string {
  const trimmed = vendor?.trim() || "";
  if (provider === "cursor") return CURSOR_VENDOR;
  return trimmed || "deepseek";
}

export function accountDisplayName(account: {
  accountId?: string;
  label: string;
  provider: string;
  vendor: string;
}): string {
  const label = account.label.trim() || account.accountId || "account";
  if (account.provider === "cline" && account.vendor && account.vendor !== account.provider) {
    return `${account.vendor} / ${label}`;
  }
  return label;
}

/** 掩码：保留前后各一点，中间用 …。太短的 key 全遮。 */
export function maskApiKey(apiKey: string | undefined | null): string {
  const raw = (apiKey ?? "").trim();
  if (!raw) return "";
  if (raw.length <= 8) return "••••";
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

export function toPublicAccount(row: ProviderAccountSecret): ProviderAccount {
  const { apiKey: _apiKey, ...pub } = row;
  return { ...pub, apiKeyMasked: maskApiKey(row.apiKey) };
}

export function assertAccountInput(
  input: ProviderAccountInput,
  opts?: { requireKey?: boolean },
): {
  provider: AccountProvider;
  vendor: string;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  agentRootWorkspace: string;
  enabled: boolean;
  isDefault: boolean;
} {
  if (!isAccountProvider(input.provider)) {
    throw new Error(
      `unknown account provider "${input.provider}". Supported: cursor, cline`,
    );
  }
  const label = input.label.trim();
  if (!label) throw new Error("label is required");
  const agentRootWorkspace = normalizeAgentRootWorkspace(input.agentRootWorkspace);
  if (!agentRootWorkspace) throw new Error("agentRootWorkspace is required");
  if (!isAbsoluteWorkspace(agentRootWorkspace)) {
    throw new Error("agentRootWorkspace must be an absolute path");
  }
  const apiKey = input.apiKey?.trim() || undefined;
  if (opts?.requireKey && !apiKey) {
    throw new Error("apiKey is required");
  }
  const vendor = normalizeVendor(input.provider, input.vendor);
  if (input.provider === "cline" && !vendor) {
    throw new Error("vendor is required for cline accounts (e.g. deepseek, minimax)");
  }
  return {
    provider: input.provider,
    vendor,
    label,
    ...(apiKey ? { apiKey } : {}),
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    agentRootWorkspace,
    enabled: input.enabled !== false,
    isDefault: Boolean(input.isDefault),
  };
}

function isAbsoluteWorkspace(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Collapse `.` / `..` / extra slashes and drop a trailing separator so
 * `/data/ws/` and `/data/ws` count as the same root.
 */
export function normalizeAgentRootWorkspace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = path.normalize(trimmed);
  if (normalized === path.sep) return normalized;
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) {
    return `${normalized[0]}:\\`;
  }
  return normalized.replace(/[\\/]+$/, "");
}

export function findAccountUsingRoot<
  T extends { accountId: string; agentRootWorkspace: string },
>(accounts: T[], root: string, exceptId?: string): T | undefined {
  const want = normalizeAgentRootWorkspace(root);
  if (!want) return undefined;
  return accounts.find(
    (account) =>
      account.accountId !== exceptId &&
      normalizeAgentRootWorkspace(account.agentRootWorkspace) === want,
  );
}

export function duplicateAgentRootMessage(label: string, root: string): string {
  return `工作根目录已被账号「${label}」占用（${root}）。不同账号必须使用不同的工作根目录。`;
}

export function listDuplicateAgentRoots<
  T extends { accountId: string; label: string; agentRootWorkspace: string },
>(accounts: T[]): Array<{ root: string; accounts: T[] }> {
  const grouped = new Map<string, T[]>();
  for (const account of accounts) {
    const key = normalizeAgentRootWorkspace(account.agentRootWorkspace);
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(account);
    grouped.set(key, list);
  }
  return [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([root, group]) => ({ root, accounts: group }));
}

/** Cline SDK 登记的 LLM 厂商；拿不到就退回常见名单。 */
export function listClineVendors(): string[] {
  try {
    const ids = Llms.getProviderIds();
    if (ids.length) return [...ids].sort();
  } catch {
    /* SDK 目录不可用 */
  }
  return [...FALLBACK_CLINE_VENDORS];
}
