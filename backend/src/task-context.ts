import type {
  AgentEvent,
  OrgServiceList,
  Project,
  RunRecord,
  Task,
} from "./types.js";
import { normalizeTaskType, taskTypeLabel } from "./task-types.js";
import { taskGoalInfo } from "./task-goals.js";
import { loadPromptFile } from "./prompt-files.js";

/**
 * 两块 prompt（初始化 system prompt + task prompt）**加起来**的字符上限。
 *
 * 7500 是"只有一块"时的老口径；分成两块后固定开销变大了（协议那半 ~3KB），所以提到 10000，
 * 让历史段能留下的量级与老口径一致（见 `backend/scripts/test-transparency.mjs` 的保尾部断言）。
 */
export const MAX_BOOTSTRAP_CHARS = 10000;
/** 简报里最多逐个列几个仓库（骨架预算有限；超出的折成一句「还有 N 个」）。 */
const MAX_INJECTED_REPOS = 12;
const MAX_USER_MESSAGES = 20;
const MAX_RUN_RESULTS = 10;
const MAX_LINE_CHARS = 400;
const MAX_ATTACHMENT_LINES = 20;
/**
 * 简报骨架里任务描述的上限：描述是"需求原文"，但骨架先占预算，
 * 太长会把 History 挤没（旧的 bug 就是把最近历史裁掉了）。超出截断并注明。
 */
const MAX_DESCRIPTION_CHARS = 2000;
/**
 * **初始化 system prompt**（`task.systemPrompt`）的上限：它是人工写的文本（换行保留，不折叠），
 * 但也不能把会话预算吃光。超了截断并注明（路由层还会先按这个值拒一次 400）。
 */
export const MAX_SYSTEM_PROMPT_CHARS = 8000;

/** 历史段预算的分配（骨架先占，剩下来的按这个比例分给两段）。 */
const RUN_RESULTS_SHARE = 0.4;

export interface TaskBootstrapInput {
  task: Task;
  project?: Project;
  events: AgentEvent[];
  runs: RunRecord[];
  /**
   * 服务中心按组织（`project.department.departmentId`）给出的服务清单。
   *
   * **简报里注入的仓库地址只来自这里** —— 项目上已经没有仓库地址字段了
   * （老的 `project.gitRepoUrl` 已删除；单一真源是服务中心，见 `./service-registry.ts`）。
   * 缺省 / 服务中心不可达 → 简报退回「按需自己 clone」的兜底文案。
   */
  orgServices?: OrgServiceList;
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
  /**
   * 两块 prompt 的体检（**分开记**）：system 那半用的是**这条 task 自己存的**（`task`）还是
   * **模板生成**的（`template`），以及两半各多少字符。
   */
  prompts?: {
    system: { source: "task" | "template"; chars: number };
    task: { chars: number };
  };
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * 只截长度、**不动换行**的截断（prompt 正文不能像 `clip` 那样把换行压掉）。
 * 注明那句话也算在 `max` 里 —— 返回的文本绝不超上限（路由层按同一个上限拒 400，两边口径一致）。
 */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = `…（已截断：初始化 system prompt 上限 ${max} 字符）`;
  return `${text.slice(0, Math.max(0, max - note.length))}${note}`;
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

/**
 * 注入 agent 的仓库清单（中心思想：**仓库地址来自服务中心，不是项目配置**）。
 *
 * 只列**带仓库地址**的服务 —— 简报要的是 origin 候选。行数封顶（`MAX_INJECTED_REPOS`），
 * 超出折成一句「还有 N 个」，免得把简报的历史段预算吃光。
 */
function injectedRepoLines(orgServices?: OrgServiceList): string[] {
  const repos = (orgServices?.items ?? []).filter((s) => s.gitRepoUrl?.trim());
  if (!repos.length) return [];
  const orgId = orgServices?.orgId ?? "";
  const orgLabel = orgServices?.orgName
    ? `${orgId} ${orgServices.orgName}`
    : orgId || "unknown";
  const shown = repos.slice(0, MAX_INJECTED_REPOS);
  const hidden = repos.length - shown.length;
  return [
    "## 注入的仓库（origin 候选）",
    `- **Injected git repositories (origin candidates, from the service registry · org ${orgLabel}):**`,
    ...shown.map((s) => {
      const note = s.description ? ` — ${clip(s.description, 120)}` : "";
      return `  - \`${s.name}\` → \`${s.gitRepoUrl}\`${note}`;
    }),
    ...(hidden > 0 ? [`  - …另有 ${hidden} 个服务（完整清单见服务中心）`] : []),
    `- 来源：服务中心 \`GET /v1/orgs/${orgId}/services\`（组织 ${orgLabel}；由 project 的所属组织解析）。项目配置里**没有**仓库地址字段，origin 只认上面这些。`,
  ];
}

/**
 * **初始化 system prompt** 的模板文件（仓库根相对路径）：协议的那一份文字住在文件里，
 * 不在代码里 —— 改措辞 = 改文件，下一次会话生效（`loadPromptFile`，见 `docs/prompts.md`）。
 */
const PROTOCOL_TEMPLATE_REL = "agent_policy/PROTOCOL.md";

/** 两个 prompt 各自体检后的文本（`source` 说清它从哪来）。 */
export interface TaskPromptHalf {
  text: string;
  /** `task` = 这条 task 自己存的那份（`task.systemPrompt`）；`template` = 按模板生成。 */
  source: "task" | "template";
}

/** 一条 task 的**两份 prompt**：初始化用那份 + 任务相关那份，各管各的。 */
export interface TaskPrompts {
  /** **初始化 system prompt**：开会话时给模型的系统提示词（provider 有 system 通道就走那条）。 */
  system: TaskPromptHalf;
  /** **task prompt**：任务相关（需求原文 + 历史 + 本轮用户消息的引导尾）。 */
  task: { text: string };
  /** 模板生成的那份 system prompt：UI 上「恢复模板」/「看默认长什么样」用。 */
  template: { system: string };
  /** 体检数据 + **合成文本**（`system` + 分隔 + `task`）：provider 没有 system 通道时送它。 */
  bootstrap: TaskBootstrap;
}

/**
 * **初始化 system prompt**（模板）：一个 task 的 agent 开会话时给模型的**系统提示词**。
 *
 * **只讲协议，不含这条 task 的任何具体信息** —— 身份（taskId / title / workspace / goal / prUrl）、
 * 注入的仓库清单、需求原文、历史**全部在 task prompt 那一块**（`buildTaskPromptText`）。
 * 所以这份模板**对所有 task 都一样**，而且它是**文件**（`backend/src/agent_policy/PROTOCOL.md`，
 * 构建时拷进 `dist/agent_policy/`，所以部署上也能直接改措辞）：
 * `task.systemPrompt` 设了就用那份覆盖（见 `buildTaskPrompts`）。
 *
 * 两块**分开独立管理**：这里给模板默认值；面板上两块各改各的，改一块不动另一块。
 */
export function buildInitSystemPrompt(): string {
  return loadPromptFile(PROTOCOL_TEMPLATE_REL);
}

/**
 * **task prompt**（任务相关那半）：**这一单的具体信息** —— 任务身份（taskId / title / type / goal /
 * project / workspace / createdAt / PR URL）+ 服务中心给的仓库清单 + 需求原文（`task.description`）+ 历史
 * 摘要 + 本轮用户消息的引导尾。
 *
 * 新开会话时它作为**用户消息**送出；`buildInitSystemPrompt` 那半走 session 的 system 通道（provider
 * 支持的话）。两块内容不重叠：改这块不动那块，反之亦然（`task.description` vs `task.systemPrompt`）。
 */
export function buildTaskPromptText(
  input: TaskBootstrapInput,
  opts?: { reserveChars?: number },
): {
  text: string;
  keptUserMessages: number;
  keptRunResults: number;
  droppedUserMessages: number;
  droppedRunResults: number;
  carriedKept?: { taskId: string; userMessages: number; runResults: number };
} {
  const { task, events, runs } = input;
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

  // ---- 这一单的**具体信息**：system 那半只讲协议，身份 / 仓库清单 / 需求原文全在这里 ----
  const taskType = normalizeTaskType(task.taskType);
  // 类型是纯标签：只在**非 general** 时写一行（历史任务全是 general，保持一致）。
  const typeLines =
    taskType === "general"
      ? []
      : [`- type: ${taskTypeLabel(taskType)} (${taskType})`];
  // 目标**会改变 agent 的动作**（做到哪一步算交付完成）：协议在 system 那半，这里只写这一单选的值。
  const goalInfo = taskGoalInfo(task.goal);
  const goalLines = goalInfo ? [`- goal: ${goalInfo.label} (${goalInfo.id})`] : [];
  const identityLines = [
    "## Task identity",
    `- taskId: ${task.taskId}`,
    `- title: ${task.title}`,
    ...typeLines,
    ...goalLines,
    `- project: ${input.project?.name ?? task.projectId} (${task.projectId})`,
    `- workspace: ${task.workspace}`,
    `- createdAt: ${task.createdAt}`,
    ...(task.prUrl
      ? [`- **Existing pull request:** ${task.prUrl} (do not open a duplicate PR).`]
      : []),
  ];
  // 服务中心给的仓库清单（origin 候选）：协议在 system 那半（"origin 只认这些"），这里给的是清单本身。
  const repoLines = injectedRepoLines(input.orgServices);
  const fixedText = [...identityLines, ...repoLines].join("\n");

  // 描述是"需求原文"：会话被重建（重启 / 轮转 / fork）后必须还在，
  // 所以进这里而不是只依赖事件流（事件会被简报的"保尾部"裁掉）。
  const description = task.description?.trim() ?? "";
  const descriptionText = description
    ? [
        "## 任务描述",
        description.length > MAX_DESCRIPTION_CHARS
          ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…（已截断，完整见 \`GET /api/tasks/${task.taskId}\`）`
          : description,
      ].join("\n")
    : "";
  const attachmentText = attachments.length
    ? ["### Attachments (ids only)", ...attachments].join("\n")
    : "";
  // 上限是**两块加起来**的：这里减掉 system 那半（`reserveChars`）与描述段，才是历史段的额度。
  const budget = Math.max(
    0,
    MAX_BOOTSTRAP_CHARS -
      (opts?.reserveChars ?? 0) -
      fixedText.length -
      descriptionText.length -
      TAIL.length -
      attachmentText.length -
      80,
  );

  // run 结论更稀缺（每轮一条），先给它 40%，用户消息拿剩下的。
  const runBudget = Math.floor(budget * RUN_RESULTS_SHARE);
  const fittedRuns = fitLines(runResults, runBudget);
  const fittedUsers = fitLines(userMsgs, Math.max(0, budget - fittedRuns.used));

  const parts: string[] = [
    ...identityLines,
    ...repoLines,
    ...(descriptionText ? [descriptionText] : []),
    "## History summary",
  ];
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

  const carriedKept = carried
    ? {
        taskId: carried.taskId,
        userMessages: fittedUsers.kept.filter((l) => l.includes(carriedTag)).length,
        runResults: fittedRuns.kept.filter((l) => l.includes(carriedTag)).length,
      }
    : undefined;
  return {
    text: parts.filter((s) => s !== "").join("\n"),
    keptUserMessages: fittedUsers.kept.length,
    keptRunResults: fittedRuns.kept.length,
    droppedUserMessages: userMsgs.length - fittedUsers.kept.length,
    droppedRunResults: runResults.length - fittedRuns.kept.length,
    ...(carriedKept ? { carriedKept } : {}),
  };
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

/** 两块 prompt 之间的分隔（也是「任务相关的那块从这里开始」的标记）。 */
export const PROMPT_SEPARATOR = "\n\n---\n\n";

/**
 * 一条 task 的**两份 prompt** —— 各管各的，互不影响：
 *
 * | | 存哪 | 默认从哪来 | 送哪 |
 * |---|---|---|---|
 * | **初始化 system prompt** | `task.systemPrompt` | `buildInitSystemPrompt`（模板） | session 的 system 通道（provider 支持时；cursor 没有 → 前置成本轮消息的第一块） |
 * | **task prompt** | `task.description` | 用户创建时填的「需求原文」 | 用户消息（`buildTaskPromptText` + 本轮的 user text） |
 *
 * 体检数据（`bootstrap.systemPrompt.source/chars`）会写进 `run_started`：于是"这次会话到底用的模板
 * 还是这条 task 自己的那份"是可查的。
 */
export function buildTaskPrompts(input: TaskBootstrapInput): TaskPrompts {
  const templateSystem = buildInitSystemPrompt();
  const own = (input.task.systemPrompt ?? "").trim();
  const system: TaskPromptHalf = own
    ? { text: clipChars(own, MAX_SYSTEM_PROMPT_CHARS), source: "task" }
    : { text: templateSystem, source: "template" };
  const task = buildTaskPromptText(input, {
    reserveChars: system.text.length + PROMPT_SEPARATOR.length,
  });
  let text = composeTaskPrompts(system.text, task.text);
  let truncated = task.droppedUserMessages > 0 || task.droppedRunResults > 0;
  if (text.length > MAX_BOOTSTRAP_CHARS) {
    // 最后一道保险（正常不会走到：上面已经按预算装了）。
    text = `${text.slice(0, MAX_BOOTSTRAP_CHARS - 1)}…`;
    truncated = true;
  }
  const digestMeta = input.digest
    ? {
        sourceTaskId: input.digest.sourceTaskId,
        chars: input.digest.text.length,
        at: input.digest.at,
        ...(input.digest.model ? { model: input.digest.model } : {}),
      }
    : undefined;
  return {
    system,
    task: { text: task.text },
    template: { system: templateSystem },
    bootstrap: {
      text,
      chars: text.length,
      truncated,
      dropped: { userMessages: task.droppedUserMessages, runResults: task.droppedRunResults },
      kept: { userMessages: task.keptUserMessages, runResults: task.keptRunResults },
      prompts: {
        system: { source: system.source, chars: system.text.length },
        task: { chars: task.text.length },
      },
      ...(task.carriedKept ? { carried: task.carriedKept } : {}),
      ...(digestMeta ? { digestMeta } : {}),
    },
  };
}

/** 兼容旧调用：合成文本 + 体检数据（两块分开管理见 `buildTaskPrompts`）。 */
export function buildTaskBootstrap(input: TaskBootstrapInput): TaskBootstrap {
  return buildTaskPrompts(input).bootstrap;
}

/** 兼容旧调用：只要文本。 */
export function buildTaskBootstrapText(input: TaskBootstrapInput): string {
  return buildTaskPrompts(input).bootstrap.text;
}

/**
 * 两块 prompt 合成**一段文本**（provider 没有 system 通道时送它；有通道的 provider 只用 task 那半，
 * system 那半走 session 的 system 参数）。
 */
export function composeTaskPrompts(
  systemText: string | undefined,
  taskText: string | undefined,
): string {
  const system = systemText?.trim() ?? "";
  const task = taskText?.trim() ?? "";
  if (!system) return task;
  if (!task) return system;
  return `${system}${PROMPT_SEPARATOR}${task}`;
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
 *
 * 两块 prompt 分开记：`initSystemPrompt*` 是**初始化 system prompt**（`source=task` 表示用的是这条
 * task 自己存的那份）、`taskPromptChars` 是 **task prompt** 那半；`bootstrapText` 仍是**两块合成**的
 * 全文（= 这个会话的模型实际看到的那段）。
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
    ...(bootstrap.prompts
      ? {
          initSystemPromptSource: bootstrap.prompts.system.source,
          initSystemPromptChars: bootstrap.prompts.system.chars,
          taskPromptChars: bootstrap.prompts.task.chars,
        }
      : {}),
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
