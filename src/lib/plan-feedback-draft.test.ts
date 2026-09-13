import { describe, expect, it } from "vitest";
import { appendPlanFeedback, planCheckFeedback, type PlanFeedbackDraft } from "./plan-feedback-draft";

describe("teacher feedback composition", () => {
  const initial: PlanFeedbackDraft = { feedback: "교사가 직접 작성한 안내", applied: [], expectedStatus: "pending", expectedFeedback: "" };
  it("preserves teacher edits and appends checks once without replacing the message", () => {
    const first = appendPlanFeedback(initial, "r:0", "측정 간격을 정해 주세요.");
    const edited = { ...first, feedback: `${first.feedback}\n교사가 보완한 문장` };
    expect(appendPlanFeedback(edited, "r:0", "중복 내용")).toBe(edited);
    expect(appendPlanFeedback(edited, "r:1", "통제 조건을 확인해 주세요.").feedback)
      .toBe(`${edited.feedback}\n\n통제 조건을 확인해 주세요.`);
  });
  it("keeps the original meaning and known field labels", () => {
    expect(planCheckFeedback({ fieldKeys: ["method", "unknown"], category: "missing", priority: "required",
      observation: "측정 간격이 없습니다.", suggestion: "간격을 정해 주세요.", question: "얼마나 자주 측정하나요?" }, new Map([["method", "실험 방법"]])))
      .toBe("[실험 방법]\n측정 간격이 없습니다.\n간격을 정해 주세요.\n확인할 질문: 얼마나 자주 측정하나요?");
  });
  it("refuses oversized feedback without modifying the existing draft", () => {
    const long = { ...initial, feedback: "가".repeat(3999) };
    expect(() => appendPlanFeedback(long, "r:0", "추가")).toThrow("4,000자");
    expect(long.applied).toEqual([]);
    expect(long.feedback).toHaveLength(3999);
  });
});
