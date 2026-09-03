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

  it("explains device push privacy and iOS installation requirements", () => {
    const result = answerPlatformGuideQuestion("아이패드에서 푸시 기기 알림을 어떻게 켜나요?");
    expect(result.sources).toContain("공지·알림함");
    expect(result.answer).toContain("홈 화면에 추가");
    expect(result.answer).toContain("학생 정보가 표시되지 않습니다");
  });

  it("explains how to retry after notification permission was denied", () => {
    const result = answerPlatformGuideQuestion("기기 알림을 거절했는데 다시 켜기는 어떻게 하나요?");
    expect(result.sources).toContain("공지·알림함");
    expect(result.answer).toContain("알림 다시 켜기");
    expect(result.answer).toContain("강제로 다시 열 수 없습니다");
  });
});
