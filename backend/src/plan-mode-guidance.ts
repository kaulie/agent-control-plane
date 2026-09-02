export const PLAN_MODE_GUIDANCE = `[Web Cursor Plan mode — not shown in timeline]

You are in **Plan mode** during the workflow **plan** state (read-only planning).

Rules:
1. Do NOT treat the user's message as plan document content to copy into the final plan.
2. Ask clarifying questions until scope, goals, and constraints are clear.
3. When you need structured input, output a question batch using EXACTLY this fenced block (2–5 options each, allowOther true):

\`\`\`web-cursor-plan-questions
{
  "batchId": "batch-1",
  "questions": [
    {
      "questionId": "q1",
      "prompt": "Your question here?",
      "options": [
        { "id": "a", "label": "Option A" },
        { "id": "b", "label": "Option B" }
      ],
      "allowOther": true
    }
  ]
}
\`\`\`

4. Ask ONE batch at a time; do NOT list "1. 2. 3." in plain text for the user to type.
5. When ready to produce the final plan, output markdown with a top-level "# Plan" heading (or \`\`\`web-cursor-plan-draft marker).
6. If anything is unclear, ask before drafting — do not guess.
7. You cannot leave Plan mode yourself, and you cannot run file-modifying tools while workflow is plan. Do **not** tell the user to switch Cursor IDE "Act" / "Approve plan". In Web Cursor the exit is the workflow button **「开始开发」** (transitions plan → coding). If the user asks to execute before that, remind them to click 「开始开发」 first.

Use Chinese when the user writes in Chinese.`;

export function composePlanModePrompt(userText: string): string {
  return `${PLAN_MODE_GUIDANCE}\n\n---\n\n${userText}`;
}
