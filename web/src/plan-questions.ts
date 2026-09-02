import type { AgentEvent } from "./types";

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

function parseBatchPayload(payload: Record<string, unknown>): PlanQuestionBatch | null {
  const batchId = typeof payload.batchId === "string" ? payload.batchId : "";
  if (!batchId || !Array.isArray(payload.questions)) return null;
  const questions: PlanQuestion[] = [];
  for (const raw of payload.questions) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    const questionId = typeof q.questionId === "string" ? q.questionId : "";
    const prompt = typeof q.prompt === "string" ? q.prompt : "";
    if (!questionId || !prompt) continue;
    const options: PlanQuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (!opt || typeof opt !== "object") continue;
        const o = opt as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : "";
        const label = typeof o.label === "string" ? o.label : "";
        if (id && label) options.push({ id, label });
      }
    }
    if (!options.length) continue;
    questions.push({
      questionId,
      prompt,
      options,
      allowOther: q.allowOther !== false,
    });
  }
  if (!questions.length) return null;
  return { batchId, questions };
}

/** Latest unanswered plan question batch, if any. */
export function findPendingPlanQuestionBatch(
  events: AgentEvent[],
): PlanQuestionBatch | null {
  const batches: PlanQuestionBatch[] = [];
  const answered = new Set<string>();

  for (const ev of events) {
    if (ev.eventType === "plan_question_batch") {
      const batch = parseBatchPayload(ev.payload);
      if (batch) batches.push(batch);
    }
    if (ev.eventType === "user_message") {
      const pab = ev.payload.planAnswerBatch as PlanAnswerBatch | undefined;
      if (pab?.batchId) answered.add(pab.batchId);
    }
  }

  for (let i = batches.length - 1; i >= 0; i--) {
    if (!answered.has(batches[i].batchId)) return batches[i];
  }
  return null;
}

export function hasPlanDraft(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.eventType === "plan_draft") return true;
    if (ev.eventType === "agent_response") {
      const text = String(ev.payload.text ?? "");
      if (/^#\s*plan\b/im.test(text) || /^##\s*计划/m.test(text)) return true;
    }
  }
  return false;
}
