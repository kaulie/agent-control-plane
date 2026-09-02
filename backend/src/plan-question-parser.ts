export interface PlanQuestionOption {
  id: string;
  label: string;
}

export interface PlanQuestion {
  questionId: string;
  prompt: string;
  options: PlanQuestionOption[];
  allowOther?: boolean;
}

export interface PlanQuestionBatch {
  batchId: string;
  questions: PlanQuestion[];
}

export interface PlanAnswer {
  questionId: string;
  optionId?: string;
  optionLabel?: string;
  otherText?: string;
  skipped?: boolean;
}

export interface PlanAnswerBatch {
  batchId: string;
  answers: PlanAnswer[];
}

const QUESTIONS_FENCE = /```web-cursor-plan-questions\s*\n([\s\S]*?)```/i;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseQuestion(raw: unknown): PlanQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const questionId = asString(o.questionId);
  const prompt = asString(o.prompt);
  if (!questionId || !prompt) return null;
  const options: PlanQuestionOption[] = [];
  if (Array.isArray(o.options)) {
    for (const item of o.options) {
      if (!item || typeof item !== "object") continue;
      const opt = item as Record<string, unknown>;
      const id = asString(opt.id);
      const label = asString(opt.label);
      if (id && label) options.push({ id, label });
    }
  }
  if (!options.length) return null;
  return {
    questionId,
    prompt,
    options,
    allowOther: o.allowOther !== false,
  };
}

export function parsePlanQuestionBatch(text: string): {
  batch: PlanQuestionBatch | null;
  strippedText: string;
} {
  const match = QUESTIONS_FENCE.exec(text);
  if (!match) return { batch: null, strippedText: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return { batch: null, strippedText: text };
  }
  if (!parsed || typeof parsed !== "object") {
    return { batch: null, strippedText: text };
  }
  const o = parsed as Record<string, unknown>;
  const batchId = asString(o.batchId) ?? `batch-${Date.now()}`;
  const questions: PlanQuestion[] = [];
  if (Array.isArray(o.questions)) {
    for (const q of o.questions) {
      const parsedQ = parseQuestion(q);
      if (parsedQ) questions.push(parsedQ);
    }
  }
  if (!questions.length) {
    return { batch: null, strippedText: text };
  }
  const strippedText = text.replace(match[0], "").trim();
  return { batch: { batchId, questions }, strippedText };
}

export function formatPlanAnswerBatchForAgent(batch: PlanAnswerBatch): string {
  const lines = batch.answers.map((a) => {
    if (a.skipped) return `- ${a.questionId}: (skipped)`;
    if (a.otherText?.trim()) {
      return `- ${a.questionId}: Other — ${a.otherText.trim()}`;
    }
    return `- ${a.questionId}: ${a.optionLabel ?? a.optionId ?? "(selected)"}`;
  });
  return `[Plan question answers for batch ${batch.batchId}]\n${lines.join("\n")}`;
}

export function isPlanDraftText(text: string): boolean {
  const t = text.trim();
  if (/```web-cursor-plan-draft/i.test(t)) return true;
  if (/^#\s*plan\b/im.test(t)) return true;
  if (/^##\s*计划/m.test(t)) return true;
  return false;
}
