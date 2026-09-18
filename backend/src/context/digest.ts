/**
 * 会话 digest：把一段工作历史**用模型压成摘要**。
 *
 * 用途（两个都**默认关闭**，`CONTEXT_DIGEST=1` 才开）：
 * - fork 新 task 时：把来源 task 的历史压成摘要（比原样搬 7.5KB 原始行更省、更结构化）；
 * - 上下文轮转时：给新会话一份长期摘要，原始近况仍来自启动简报。
 *
 * 设计约束：
 * - 只走 **OpenAI 兼容**的 `/chat/completions`（DeepSeek 就是），不依赖 SDK；
 * - **永不抛错**：超时/HTTP 错/解析失败都返回 `undefined`，调用方回退到原始历史 ——
 *   摘要失败绝不能让主流程（用户发消息）失败；
 * - 生成结果写进 DB（按水位缓存）并在时间线记一条 `status: digest`，可审计。
 */
export interface DigestProviderConfig {
  modelId: string;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface DigestRequest {
  /** 要压缩的原文（调用方负责裁剪与标注）。 */
  text: string;
  provider: DigestProviderConfig;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** 测试注入用；缺省用全局 `fetch`。 */
  fetchImpl?: typeof fetch;
}

export interface DigestResult {
  summary: string;
  model: string;
  chars: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;
const DIGEST_SYSTEM_PROMPT = [
  "You are a session handoff summarizer for an autonomous coding agent.",
  "Compress the given work history into a compact, factual handoff summary.",
  "Sections (keep the headings, drop empty ones): 目标 / 已完成 / 未完成 / 关键产物 / 坑与注意事项.",
  "Keep file paths, branch names, PR/MR links, command names and error messages verbatim.",
  "Do NOT invent anything that is not in the history. Output the summary only, no preamble.",
].join(" ");

/** 拼给模型的用户消息（纯函数，便于测试）。 */
export function buildDigestPrompt(text: string): string {
  return [
    "请把下面的工作历史压缩成交接摘要（≤400 字，中文），保留可执行信息：文件路径 / 分支 / PR 链接 / 命令 / 报错原文。",
    "",
    "--- 工作历史开始 ---",
    text,
    "--- 工作历史结束 ---",
  ].join("\n");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path}`;
}

/**
 * 调一次模型生成摘要。**任何异常都吞掉**（返回 undefined），并打一条 warn。
 */
export async function generateDigest(request: DigestRequest): Promise<DigestResult | undefined> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const baseUrl = request.provider.baseUrl?.trim();
  if (!fetchImpl || !baseUrl) {
    console.warn("[digest] skipped: no fetch or baseUrl", { provider: request.provider.providerId });
    return undefined;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(joinUrl(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.provider.apiKey ? { authorization: `Bearer ${request.provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.provider.modelId,
        messages: [
          { role: "system", content: DIGEST_SYSTEM_PROMPT },
          { role: "user", content: buildDigestPrompt(request.text) },
        ],
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[digest] HTTP ${res.status} from summarizer`);
      return undefined;
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = body.choices?.[0]?.message?.content?.trim();
    if (!summary) return undefined;
    return { summary, model: request.provider.modelId, chars: summary.length };
  } catch (err) {
    console.warn("[digest] failed:", err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 取源：把 task 的近期历史拼成有界文本（纯函数，便于测试） ----

const MAX_USER_LINES = 20;
const MAX_RUN_LINES = 12;
const MAX_DECISION_LINES = 20;
const MAX_LINE_CHARS = 400;
const SECTION_BUDGET = { users: 8_000, runs: 6_000, decisions: 4_000 };

function clip(text: string, max = MAX_LINE_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function takeTail(lines: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept;
}

interface DigestEventLike {
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface DigestRunLike {
  runId: string;
  status: string;
  createdAt: string;
  result?: string;
  error?: string;
}

export interface DigestSourceInput {
  taskId: string;
  title: string;
  workspace?: string;
  prUrl?: string;
  events: readonly DigestEventLike[];
  runs: readonly DigestRunLike[];
  /** 总字符上限（默认 20k）。 */
  maxChars?: number;
}

/**
 * 拼 digest 原文：任务身份 + 最近的用户要求 / 每轮结果 / 关键决策（都是**保尾部**）。
 * 只喂"已经发生过的事实"，不喂工具输出原文 —— 让摘要模型专心做压缩。
 */
export function digestSourceText(input: DigestSourceInput): string {
  const maxChars = Math.max(2_000, input.maxChars ?? 20_000);
  const userLines: string[] = [];
  const decisionLines: string[] = [];
  for (const ev of input.events) {
    const payload = ev.payload ?? {};
    if (ev.eventType === "user_message") {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text.trim()) userLines.push(`- [${ev.timestamp}] ${clip(text)}`);
    } else if (ev.eventType === "agent_decision") {
      const summary =
        (typeof payload.summary === "string" && payload.summary) ||
        (typeof payload.decision === "string" && payload.decision) ||
        (typeof payload.note === "string" && payload.note) ||
        "";
      if (summary.trim()) decisionLines.push(`- [${ev.timestamp}] ${clip(summary)}`);
    }
  }
  const runLines = input.runs.map((r) => {
    const body = r.status === "error" ? r.error ?? "(no error text)" : r.result ?? "(no result text)";
    return `- [${r.createdAt}] ${r.status} ${r.runId.slice(-8)}: ${clip(body)}`;
  });

  const parts: string[] = [
    "# 任务",
    `- taskId: ${input.taskId}`,
    `- title: ${input.title}`,
    ...(input.workspace ? [`- workspace: ${input.workspace}`] : []),
    ...(input.prUrl ? [`- PR: ${input.prUrl}`] : []),
    "",
    "# 用户的最近要求",
    ...takeTail(userLines.slice(-MAX_USER_LINES), SECTION_BUDGET.users),
    "",
    "# 每轮 run 的结果",
    ...takeTail(runLines.slice(-MAX_RUN_LINES), SECTION_BUDGET.runs),
  ];
  const decisions = takeTail(decisionLines.slice(-MAX_DECISION_LINES), SECTION_BUDGET.decisions);
  if (decisions.length) parts.push("", "# 关键决策", ...decisions);

  const text = parts.join("\n");
  if (text.length <= maxChars) return text;
  // 超上限：保头部（任务身份）+ 尾部（最近的事），中间省略。
  const head = text.slice(0, 1_000);
  return `${head}\n…（中间省略 ${text.length - maxChars} 字符）\n${text.slice(-(maxChars - 1_100))}`;
}
