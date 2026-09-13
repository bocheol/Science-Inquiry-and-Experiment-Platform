import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LiveAiPanel } from "@/components/live-ai-panel";
import { MeetingAudioInput } from "@/components/meeting-audio-input";

it("states that live AI never receives journals and does not save the live conversation", () => {
  const html = renderToStaticMarkup(React.createElement(LiveAiPanel, { sessionId: "session", cycleId: "cycle", available: true }));
  expect(html).toContain("개인 일지는 전혀 전송하지 않습니다");
  expect(html).toContain("60초 동안 새 발화가 없으면 자동 종료");
  expect(html).toContain("일지나 팀 기록으로 저장하지 않습니다");
});

it("keeps meeting transcription in the existing reviewed memo flow", () => {
  const html = renderToStaticMarkup(React.createElement(MeetingAudioInput, {
    sessionId: "session", cycleId: "cycle", value: "", onChange: () => undefined,
  }));
  expect(html).toContain("음성으로 메모");
  expect(html).toContain("녹음 파일은 전사에만 사용하고 보관하지 않습니다");
  expect(html).toContain("확인·수정한 뒤 기존 방식으로 저장");
});
