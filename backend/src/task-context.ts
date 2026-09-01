import type { AgentEvent, Project, RunRecord, Task } from "./types.js";

const MAX_BOOTSTRAP_CHARS = 7500;
const MAX_USER_MESSAGES = 20;
const MAX_RUN_RESULTS = 10;
const MAX_LINE_CHARS = 400;

export interface TaskBootstrapInput {
  task: Task;
  project?: Project;
  events: AgentEvent[];
  runs: RunRecord[];
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function collectUserMessages(events: AgentEvent[]): string[] {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.eventType !== "user_message") continue;
    const text = typeof ev.payload.text === "string" ? ev.payload.text : "";
    if (!text.trim()) continue;
    lines.push(`- [${ev.timestamp}] ${clip(text, MAX_LINE_CHARS)}`);
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
  return lines;
}

function collectRunResults(runs: RunRecord[]): string[] {
  const done = runs.filter(
    (r) => r.status === "finished" || r.status === "error" || r.status === "cancelled",
  );
  const recent = done.slice(-MAX_RUN_RESULTS);
  return recent.map((r) => {
    const body =
      r.status === "error"
        ? r.error || "(no error text)"
        : r.result || "(no result text)";
    return `- [${r.createdAt}] ${r.status} ${r.runId.slice(-8)}: ${clip(body, MAX_LINE_CHARS)}`;
  });
}

/**
 * Build a one-shot briefing injected only on Agent.create (not shown in the
 * Web Cursor timeline). Keeps the agent aware of task identity + history.
 */
export function buildTaskBootstrapText(input: TaskBootstrapInput): string {
  const { task, project, events, runs } = input;
  const userMsgs = collectUserMessages(events);
  const attachments = collectAttachments(events);
  const runResults = collectRunResults(runs);

  const sections: string[] = [
    "[Web Cursor task bootstrap — injected once on agent create; not a user message]",
    "",
    "## Task identity",
    `- taskId: ${task.taskId}`,
    `- title: ${task.title}`,
    `- project: ${project?.name ?? task.projectId} (${task.projectId})`,
    `- workspace: ${task.workspace}`,
    `- status: ${task.status}`,
    `- createdAt: ${task.createdAt}`,
    "",
    "## Your role",
    "- Your lifecycle is this task: you exist to solve problems for this task until it is completed or closed.",
    "- Stay focused on this task's context; do not treat yourself as a generic unbound agent.",
    "- Prefer answering from this briefing + conversation; look up the DB only if needed.",
    "",
    "## History summary",
  ];

  if (userMsgs.length === 0 && runResults.length === 0 && attachments.length === 0) {
    sections.push("- (no prior history on this task yet)");
  } else {
    if (userMsgs.length) {
      sections.push("### Recent user messages", ...userMsgs, "");
    }
    if (runResults.length) {
      sections.push("### Recent run outcomes", ...runResults, "");
    }
    if (attachments.length) {
      sections.push("### Attachments (ids only)", ...attachments, "");
    }
  }

  sections.push(
    "## Current user message",
    "The text after this block is the user's actual message for this turn.",
  );

  let text = sections.join("\n");
  if (text.length > MAX_BOOTSTRAP_CHARS) {
    text = `${text.slice(0, MAX_BOOTSTRAP_CHARS - 1)}…`;
  }
  return text;
}

export function composePromptWithBootstrap(
  bootstrapText: string | undefined,
  userText: string,
): string {
  if (!bootstrapText?.trim()) return userText;
  return `${bootstrapText.trim()}\n\n---\n\n${userText}`;
}
