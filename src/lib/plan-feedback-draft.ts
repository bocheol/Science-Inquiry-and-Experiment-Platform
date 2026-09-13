import type { PlanReviewResult } from "@/lib/plan-ai-review";

export type PlanFeedbackDraft = {
  feedback: string;
  applied: string[];
  expectedStatus: string;
  expectedFeedback: string;
};

export function isPlanFeedbackDraft(value: unknown): value is PlanFeedbackDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<PlanFeedbackDraft>;
  return typeof draft.feedback === "string" && typeof draft.expectedStatus === "string"
    && typeof draft.expectedFeedback === "string" && Array.isArray(draft.applied)
    && draft.applied.every((id) => typeof id === "string");
}

export function planCheckFeedback(check: PlanReviewResult["checks"][number], labels: Map<string, string>) {
  const fields = [...new Set(check.fieldKeys.map((key) => labels.get(key)).filter(Boolean))];
  // Keep the existing AI meaning; composing feedback must not make another AI request.
  return [fields.length ? `[${fields.join(" · ")}]` : "[계획서 보완]",
    check.observation.trim(), check.suggestion.trim(),
    check.question.trim() ? `확인할 질문: ${check.question.trim()}` : ""].filter(Boolean).join("\n");
}

export function appendPlanFeedback(draft: PlanFeedbackDraft, id: string, text: string): PlanFeedbackDraft {
  if (draft.applied.includes(id)) return draft;
  const feedback = `${draft.feedback}${draft.feedback ? "\n\n" : ""}${text}`;
  if (feedback.length > 4000) throw new Error("교사 피드백은 4,000자까지 보낼 수 있습니다. 작성한 내용을 줄인 뒤 다시 반영해 주세요.");
  return { ...draft, feedback, applied: [...draft.applied, id] };
}
