import { expect, it } from "vitest";
import { evidenceFor } from "@/lib/exam-service";
import type { GeneratedExamQuestion } from "@/lib/exam-ai";
const question = (keys: string[]): GeneratedExamQuestion => ({ stimulus: "표준 대체 상황", question: "합성 질문", competency: "자료 해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [], sourceKeys: keys });
const sources = [1, 2, 3].map(index => ({ key: `journal.cycle.record.${index}`, label: `근거 ${index}`, text: "합성 관찰".repeat(200) + index }));

it("retains all selected excerpts exactly as sent, including the third source and text beyond 700 characters", () => {
  const evidence = evidenceFor(question(sources.map(source => source.key)), sources, "individual");
  expect(evidence.map(item => item.excerpt)).toEqual(sources.map(source => source.text));
  expect(evidence.map(item => item.sourceKey)).toEqual(sources.map(source => source.key));
});
it.each([[], ["unknown"], [sources[0]!.key, "another-student-journal"]].map(keys => ({ keys })))("rejects absent or mixed invalid source keys $keys instead of substituting a record", ({ keys }) => {
  expect(() => evidenceFor(question(keys), sources, "individual")).toThrow("출처");
});
it("rejects ambiguous duplicate input keys", () => {
  expect(() => evidenceFor(question([sources[0]!.key]), [sources[0]!, sources[0]!], "team")).toThrow("출처");
});
it("labels a no-record personal fallback separately and never substitutes it for existing records or team sources", () => {
  expect(evidenceFor(question([]), [], "individual")).toEqual([{ sourceType: "neutral_fallback", sourceLabel: "개인 기록 부족 · 표준 대체 자료", sourceKey: "neutral_fallback", excerpt: "표준 대체 상황" }]);
  expect(() => evidenceFor(question([]), [], "team")).toThrow("출처");
  expect(() => evidenceFor(question(["invented"]), [], "individual")).toThrow("출처");
});
