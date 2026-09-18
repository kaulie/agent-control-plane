import type { AgentEvent, Project, RunRecord, Task } from "./types.js";

const MAX_BOOTSTRAP_CHARS = 7500;
const MAX_USER_MESSAGES = 20;
const MAX_RUN_RESULTS = 10;
const MAX_LINE_CHARS = 400;
const MAX_ATTACHMENT_LINES = 20;

/** 历史段预算的分配（骨架先占，剩下来的按这个比例分给两段）。 */
const RUN_RESULTS_SHARE = 0.4;

export interface TaskBootstrapInput {
  task: Task;
  project?: Project;
  events: AgentEvent[];
  runs: RunRecord[];
  /**
   * 从别的 task fork 过来的历史（上下文将满时的分流）：只进 prompt，**不落本 task 的事件流**
   * —— 用户要求"历史不一定要显示在新 task 里"，但模型要能接着干。
   */
  carried?: TaskBootstrapCarried;
  /**
   * 模型生成的会话摘要（`CONTEXT_DIGEST=1` 时才有）：有它就**替代**原始 carried 行
   * （这才是"compaction"），并保留"完整历史见 …"的指针。
   */
  digest?: TaskBootstrapDigest;
}

export interface TaskBootstrapDigest {
  text: string;
  sourceTaskId: string;
  at: string;
  model?: string;
}

export interface TaskBootstrapCarried {
  taskId: string;
  title: string;
  events: AgentEvent[];
  runs: RunRecord[];
}

/** 简报的产出 + 它的"体检数据"（要写进 `run_started` 事件，便于事后核对）。 */
export interface TaskBootstrap {
  text: string;
  chars: number;
  /** 有没有因为超预算丢掉历史行（用户消息 / run 结论）。 */
  truncated: boolean;
  dropped: { userMessages: number; runResults: number };
  kept: { userMessages: number; runResults: number };
  /** 带了别的 task 的历史时，说明来源与带了多少（透明化）。 */
  carried?: { taskId: string; userMessages: number; runResults: number };
  /** 用了模型生成的摘要时，说明来源/字符数/模型（透明化）。 */
  digestMeta?: { sourceTaskId: string; chars: number; at: string; model?: string };
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function collectUserMessages(events: AgentEvent[], tag = ""): string[] {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.eventType !== "user_message") continue;
    const text = typeof ev.payload.text === "string" ? ev.payload.text : "";
    if (!text.trim()) continue;
    lines.push(`- ${tag}[${ev.timestamp}] ${clip(text, MAX_LINE_CHARS)}`);
  }
  return lines.slice(-MAX_USER_MESSAGES);
}

function collectAttachments(events: AgentEvent[]): string[] {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.eventType !== "user_message") continue;
    const images = ev.payload.images;
    if (!Array.isArray(images)) continue;
    for (const img of images) {
      if (!img || typeof img !== "object") continue;
      const ref = img as Record<string, unknown>;
      const id = typeof ref.id === "string" ? ref.id : "?";
      const mime = typeof ref.mimeType === "string" ? ref.mimeType : "unknown";
      lines.push(`- ${id} (${mime})`);
    }
  }
  return lines.slice(-MAX_ATTACHMENT_LINES).map((line) => clip(line, 120));
}

function collectRunResults(runs: RunRecord[], tag = ""): string[] {
  const done = runs.filter(
    (r) => r.status === "finished" || r.status === "error" || r.status === "cancelled",
  );
  const recent = done.slice(-MAX_RUN_RESULTS);
  return recent.map((r) => {
    const body =
      r.status === "error"
        ? r.error || "(no error text)"
        : r.result || "(no result text)";
    return `- ${tag}[${r.createdAt}] ${r.status} ${r.runId.slice(-8)}: ${clip(body, MAX_LINE_CHARS)}`;
  });
}

/** 固定骨架（任务身份 / 隔离规则 / 代理 / 角色）—— 不参与裁剪。 */
function skeletonSections(task: Task, project: Project | undefined): string[] {
  return [
    "[Web Cursor task bootstrap — injected once on agent create; not a user message]",
    "",
    "## Task identity",
    `- taskId: ${task.taskId}`,
    `- title: ${task.title}`,
    `- project: ${project?.name ?? task.projectId} (${task.projectId})`,
    `- workspace: ${task.workspace}`,
    `- createdAt: ${task.createdAt}`,
    "",
    "## Workspace isolation",
    `- workspace: ${task.workspace}`,
    project?.gitRepoUrl
      ? [
          `- **Configured git repository (origin):** \`${project.gitRepoUrl}\``,
          "- Follow [`BRANCHING.md`](BRANCHING.md): clone **this** GitHub URL into the task workspace, branch `feature|fix|issue/<taskId>`, develop only there, then `git commit`, `git push -u origin HEAD`, and open a PR with `gh pr create` (or `POST /api/tasks/<taskId>/pull-request`).",
          "- Persist the PR URL on the task (`prUrl`). Do not invent a different remote unless the user explicitly overrides the project git URL.",
          "- Do not merge the PR and do not deploy unless the user asks. The app itself has **no** deploy entry point: after the PR is merged into `main`, every deploy goes through the **deployment platform** (`~/runtime/agent-control-plane-deployment`, `:4220` — its UI / pipeline), which packages the merged commit and restarts the service gracefully. **Never** run a deploy/restart script synchronously inside this agent process — that kills the gateway mid-shell.",
        ].join("\n")
      : [
          "- Clone the repo you need into that directory (or a subfolder), then develop only there.",
          "- Prefer not to edit the shared deploy worktree `/Users/gaolei/Projects/deepseek_web_cursor` unless the user explicitly asks.",
        ].join("\n"),
    task.prUrl
      ? `- **Existing pull request:** ${task.prUrl} (do not open a duplicate PR).`
      : "",
    "- Do not edit other tasks' directories, and never edit `/Users/gaolei/runtime/**`.",
    "",
    "## Git / network proxy (explicit control)",
    "- Gateway may inject HTTP(S)_PROXY when `GIT_VIA_PROXY_SHELL=1` (Shell/`gh` then use the proxy).",
    "- When MCP is on (`GIT_VIA_PROXY_MCP=1`), prefer `git_with_proxy` / `run_with_proxy` for one-shot proxied fetch/pull/push/clone/`gh`.",
    "- Local-only git (status/diff/log/commit) can use normal Shell. Empty `GIT_VIA_PROXY_URL` disables all proxy features.",
    "- Capability-path choices (e.g. MCP proxied vs Shell ambient/direct) are recorded on the timeline as `agent_decision` events — not only in your prose.",
    "",
    "## Your role",
    "- Your lifecycle is this task: you exist to solve problems for this task until it is completed or closed.",
    "- Stay focused on this task's context; do not treat yourself as a generic unbound agent.",
    "- Prefer answering from this briefing + conversation; look up the DB only if needed.",
    "",
  ];
}

const TAIL = [
  "## Current user message",
  "The text after this block is the user's actual message for this turn.",
].join("\n");

/**
 * 从**最新往回**装行，保证最近的内容一定留下（这是原来那个 bug：
 * 之前是整段 `slice(0, MAX)`，超预算时先把 `### Recent run outcomes` 整段砍掉）。
 */
function fitLines(lines: string[], budget: number): { kept: string[]; used: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return { kept, used };
}

/**
 * Build the one-shot briefing injected only when a session is actually created
 * (not shown in the Web Cursor timeline).
 *
 * Budget: 固定骨架先占，剩下的按 3:2 分给「用户消息 / run 结论」，两段都**保尾部**；
 * 丢了多少行会写进 `TaskBootstrap.dropped`（由 provider 记进 `run_started` 事件）。
 */
export function buildTaskBootstrap(input: TaskBootstrapInput): TaskBootstrap {
  const { task, project, events, runs } = input;
  const digest = input.digest;
  // 有模型摘要时，carried 的原始行不再塞进简报（摘要就是压缩后的它）。
  const carried = digest ? undefined : input.carried;
  const carriedTag = carried ? `[fork:${carried.taskId.slice(-6)}] ` : "";
  // fork 过来的历史排在本 task 自己的历史**前面**（保尾部时优先留本 task 的最新内容）。
  const userMsgs = [
    ...(carried ? collectUserMessages(carried.events, carriedTag) : []),
    ...collectUserMessages(events),
  ];
  const attachments = collectAttachments(events);
  const runResults = [
    ...(carried ? collectRunResults(carried.runs, carriedTag) : []),
    ...collectRunResults(runs),
  ];

  const skeleton = skeletonSections(task, project).filter((s) => s !== "").join("\n");
  const attachmentText = attachments.length
    ? ["### Attachments (ids only)", ...attachments].join("\n")
    : "";
  const budget = Math.max(
    0,
    MAX_BOOTSTRAP_CHARS - skeleton.length - TAIL.length - attachmentText.length - 80,
  );

  // run 结论更稀缺（每轮一条），先给它 40%，用户消息拿剩下的。
  const runBudget = Math.floor(budget * RUN_RESULTS_SHARE);
  const fittedRuns = fitLines(runResults, runBudget);
  const fittedUsers = fitLines(userMsgs, Math.max(0, budget - fittedRuns.used));

  const parts: string[] = [skeleton, "## History summary"];
  if (digest) {
    parts.push(
      `## Session digest（模型生成摘要 · 源 ${digest.sourceTaskId} · ${digest.at}` +
        `${digest.model ? ` · ${digest.model}` : ""}）`,
      digest.text,
      `- 完整历史见 \`GET /api/tasks/${digest.sourceTaskId}/events\``,
      "",
    );
  }
  if (carried) {
    parts.push(
      `- 本任务由 ${carried.taskId}「${carried.title}」fork 而来（上下文已接近模型窗口，换个会话继续）。` +
        `带 [fork:${carried.taskId.slice(-6)}] 前缀的行来自它；完整历史见 \`GET /api/tasks/${carried.taskId}/events\``,
    );
  }
  if (!fittedUsers.kept.length && !fittedRuns.kept.length && !attachmentText) {
    parts.push("- (no prior history on this task yet)");
  } else {
    if (fittedUsers.kept.length) parts.push("### Recent user messages", ...fittedUsers.kept);
    if (fittedRuns.kept.length) parts.push("### Recent run outcomes", ...fittedRuns.kept);
    if (attachmentText) parts.push(attachmentText);
  }
  parts.push(TAIL);

  let text = parts.filter((s) => s !== "").join("\n");
  let truncated = false;
  if (text.length > MAX_BOOTSTRAP_CHARS) {
    // 最后一道保险（正常不会走到：上面已经按预算装了）。
    text = `${text.slice(0, MAX_BOOTSTRAP_CHARS - 1)}…`;
    truncated = true;
  }
  const droppedUserMessages = userMsgs.length - fittedUsers.kept.length;
  const droppedRunResults = runResults.length - fittedRuns.kept.length;
  const digestMeta = digest
    ? {
        sourceTaskId: digest.sourceTaskId,
        chars: digest.text.length,
        at: digest.at,
        ...(digest.model ? { model: digest.model } : {}),
      }
    : undefined;
  const carriedKept = carried
    ? {
        taskId: carried.taskId,
        userMessages: fittedUsers.kept.filter((l) => l.includes(carriedTag)).length,
        runResults: fittedRuns.kept.filter((l) => l.includes(carriedTag)).length,
      }
    : undefined;
  return {
    text,
    chars: text.length,
    truncated: truncated || droppedUserMessages > 0 || droppedRunResults > 0,
    dropped: { userMessages: droppedUserMessages, runResults: droppedRunResults },
    kept: { userMessages: fittedUsers.kept.length, runResults: fittedRuns.kept.length },
    ...(carriedKept ? { carried: carriedKept } : {}),
    ...(digestMeta ? { digestMeta } : {}),
  };
}

/** 兼容旧调用：只要文本。 */
export function buildTaskBootstrapText(input: TaskBootstrapInput): string {
  return buildTaskBootstrap(input).text;
}

export function composePromptWithBootstrap(
  bootstrapText: string | undefined,
  userText: string,
): string {
  if (!bootstrapText?.trim()) return userText;
  return `${bootstrapText.trim()}\n\n---\n\n${userText}`;
}

/**
 * 简报要写进 `run_started` 的字段（透明化 PR-5）：体检数据 + 原文。
 * 只在**真的新开会话**时记，所以量很小（每个会话一次，≤7.5KB），但能回答
 * "这个会话的模型到底看到了什么"。
 */
export function bootstrapEventPayload(
  bootstrap: TaskBootstrap | undefined,
): Record<string, unknown> {
  if (!bootstrap) return {};
  return {
    bootstrapChars: bootstrap.chars,
    bootstrapTruncated: bootstrap.truncated,
    bootstrapKeptUserMessages: bootstrap.kept.userMessages,
    bootstrapKeptRunResults: bootstrap.kept.runResults,
    bootstrapDroppedUserMessages: bootstrap.dropped.userMessages,
    bootstrapDroppedRunResults: bootstrap.dropped.runResults,
    bootstrapText: bootstrap.text,
    ...(bootstrap.digestMeta
      ? {
          bootstrapDigestSourceTaskId: bootstrap.digestMeta.sourceTaskId,
          bootstrapDigestChars: bootstrap.digestMeta.chars,
          bootstrapDigestAt: bootstrap.digestMeta.at,
          ...(bootstrap.digestMeta.model ? { bootstrapDigestModel: bootstrap.digestMeta.model } : {}),
        }
      : {}),
    ...(bootstrap.carried
      ? {
          bootstrapCarriedTaskId: bootstrap.carried.taskId,
          bootstrapCarriedUserMessages: bootstrap.carried.userMessages,
          bootstrapCarriedRunResults: bootstrap.carried.runResults,
        }
      : {}),
  };
}
