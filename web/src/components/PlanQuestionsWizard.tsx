import { useEffect, useState } from "react";
import type {
  PlanAnswer,
  PlanAnswerBatch,
  PlanQuestion,
  PlanQuestionBatch,
} from "../plan-questions";

const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function optionLetter(index: number): string {
  return OPTION_LETTERS[index] ?? String(index + 1);
}

export default function PlanQuestionsWizard({
  batch,
  onSubmit,
  disabled,
}: {
  batch: PlanQuestionBatch;
  onSubmit: (answers: PlanAnswerBatch) => void;
  disabled?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, PlanAnswer>>({});
  const [otherText, setOtherText] = useState("");
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);

  const question: PlanQuestion | undefined = batch.questions[index];
  const total = batch.questions.length;

  const currentAnswer = question ? answers[question.questionId] : undefined;

  useEffect(() => {
    if (!question) return;
    const prev = answers[question.questionId];
    if (prev?.otherText) {
      setShowOther(true);
      setOtherText(prev.otherText);
      setSelectedOptionId(null);
    } else if (prev?.optionId) {
      setShowOther(false);
      setSelectedOptionId(prev.optionId);
      setOtherText("");
    } else {
      setShowOther(false);
      setSelectedOptionId(null);
      setOtherText("");
    }
  }, [index, question, answers]);

  if (!question) return null;

  const saveCurrent = (answer: PlanAnswer): void => {
    setAnswers((prev) => ({ ...prev, [question.questionId]: answer }));
  };

  const goNext = (): void => {
    if (index < total - 1) {
      setIndex((i) => i + 1);
      return;
    }
    const list: PlanAnswer[] = batch.questions.map((q) => {
      const a = answers[q.questionId];
      return a ?? { questionId: q.questionId, skipped: true };
    });
    onSubmit({ batchId: batch.batchId, answers: list });
  };

  const handleSkip = (): void => {
    saveCurrent({ questionId: question.questionId, skipped: true });
    goNext();
  };

  const handleNext = (): void => {
    let answer: PlanAnswer | undefined;
    if (showOther && otherText.trim()) {
      answer = {
        questionId: question.questionId,
        otherText: otherText.trim(),
      };
    } else if (selectedOptionId) {
      const opt = question.options.find((o) => o.id === selectedOptionId);
      answer = {
        questionId: question.questionId,
        optionId: selectedOptionId,
        optionLabel: opt?.label,
      };
    } else if (currentAnswer) {
      answer = currentAnswer;
    } else {
      return;
    }

    const nextAnswers = { ...answers, [question.questionId]: answer };
    setAnswers(nextAnswers);

    if (index < total - 1) {
      setIndex((i) => i + 1);
      return;
    }

    const list: PlanAnswer[] = batch.questions.map((q) => {
      const a = nextAnswers[q.questionId];
      return a ?? { questionId: q.questionId, skipped: true };
    });
    onSubmit({ batchId: batch.batchId, answers: list });
  };

  const canNext =
    !!currentAnswer?.skipped ||
    !!currentAnswer?.optionId ||
    !!currentAnswer?.otherText ||
    (showOther && otherText.trim().length > 0) ||
    !!selectedOptionId;

  return (
    <div className="plan-questions-wizard">
      <div className="plan-questions-header">
        <span className="plan-questions-title">Questions</span>
        <span className="plan-questions-progress">
          {index + 1} of {total}
        </span>
      </div>
      <p className="plan-questions-prompt">{question.prompt}</p>
      <div className="plan-questions-options" role="radiogroup">
        {question.options.map((opt, i) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={!showOther && selectedOptionId === opt.id}
            className={`plan-questions-option${!showOther && selectedOptionId === opt.id ? " selected" : ""}`}
            disabled={disabled}
            onClick={() => {
              setShowOther(false);
              setSelectedOptionId(opt.id);
              setOtherText("");
            }}
          >
            <span className="plan-questions-option-letter">{optionLetter(i)}</span>
            <span className="plan-questions-option-label">{opt.label}</span>
          </button>
        ))}
        {question.allowOther !== false && (
          <button
            type="button"
            className={`plan-questions-option plan-questions-option-other${showOther ? " selected" : ""}`}
            disabled={disabled}
            onClick={() => {
              setShowOther(true);
              setSelectedOptionId(null);
            }}
          >
            <span className="plan-questions-option-letter">
              {optionLetter(question.options.length)}
            </span>
            <span className="plan-questions-option-label">Other</span>
          </button>
        )}
      </div>
      {showOther && (
        <input
          type="text"
          className="plan-questions-other-input"
          placeholder="请说明…"
          value={otherText}
          disabled={disabled}
          onChange={(e) => setOtherText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canNext) handleNext();
          }}
        />
      )}
      <div className="plan-questions-actions">
        <button
          type="button"
          className="plan-questions-btn secondary"
          disabled={disabled}
          onClick={handleSkip}
        >
          Skip
        </button>
        <button
          type="button"
          className="plan-questions-btn primary"
          disabled={disabled || !canNext}
          onClick={handleNext}
        >
          {index < total - 1 ? "Next" : "Submit"}
        </button>
      </div>
    </div>
  );
}
