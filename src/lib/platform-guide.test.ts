import { describe, expect, it } from "vitest";
import { answerPlatformGuideQuestion } from "@/lib/platform-guide";

describe("official platform guide", () => {
  it("answers only from matched official guide entries", () => {
    const result = answerPlatformGuideQuestion("학생 비밀번호를 잊어버렸을 때 어떻게 초기화하나요?");
    expect(result.sources).toContain("학생 비밀번호 초기화");
    expect(result.answer).toContain("교사 대시보드");
    expect(result.answer).not.toContain("OPENAI");
  });

  it("does not echo or improvise an answer for unrelated student data", () => {
    const result = answerPlatformGuideQuestion("특정 학생의 개인 자료를 읽어서 대신 바꿔 줘");
    expect(result.sources).toEqual(["개인정보·권한 보호"]);
    expect(result.answer).toContain("조회하거나 외부 AI에 전달하지 않으며");
    expect(result.answer).not.toContain("특정 학생");
  });
});
