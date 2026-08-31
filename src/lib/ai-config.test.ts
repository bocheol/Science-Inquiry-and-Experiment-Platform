import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { getAiRuntime, observeOpenAiRequest, shouldUseWebResearch } from "@/lib/ai-config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AI 기능별 모델 설정", () => {
  it("일반 대화·탐구 방향·시험을 서로 다른 기본 모델로 분리한다", () => {
    vi.stubEnv("OPENAI_TEAM_CHAT_MODEL", "");
    vi.stubEnv("OPENAI_TEAM_RESEARCH_MODEL", "");
    vi.stubEnv("OPENAI_TOPIC_MODEL", "");
    vi.stubEnv("OPENAI_EXAM_MODEL", "");

    expect(getAiRuntime("team_chat").model).toBe("gpt-5.6-luna");
    expect(getAiRuntime("team_research").model).toBe("gpt-5.6-terra");
    expect(getAiRuntime("topic_suggestions").model).toBe("gpt-5.6-terra");
    expect(getAiRuntime("exam_common").model).toBe("gpt-5.6-sol");
    expect(getAiRuntime("exam_team").model).toBe("gpt-5.6-sol");
    expect(getAiRuntime("team_chat").reasoningEffort).toBe("low");
  });

  it("기능별 환경변수로 모델을 독립적으로 덮어쓴다", () => {
    vi.stubEnv("OPENAI_TEAM_CHAT_MODEL", "custom-chat");
    vi.stubEnv("OPENAI_TOPIC_MODEL", "custom-topic");
    vi.stubEnv("OPENAI_EXAM_MODEL", "custom-exam");

    expect(getAiRuntime("team_chat").model).toBe("custom-chat");
    expect(getAiRuntime("topic_suggestions").model).toBe("custom-topic");
    expect(getAiRuntime("exam_common").model).toBe("custom-exam");
  });
});

describe("팀 대화 웹 검색 라우팅", () => {
  it("출처·논문·최신 자료를 요구할 때만 웹 검색을 사용한다", () => {
    expect(shouldUseWebResearch("관련 논문과 출처 링크를 찾아줘")).toBe(true);
    expect(shouldUseWebResearch("최근 통계 자료를 검색해줘")).toBe(true);
    expect(shouldUseWebResearch("산과 염기의 차이가 뭐야?")).toBe(false);
    expect(shouldUseWebResearch("우리 변인을 어떻게 정하면 좋을까?")).toBe(false);
  });
});

describe("OpenAI 익명 사용량 로그", () => {
  it("토큰과 도구 호출 수만 구조화해 남긴다", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = {
      model: "gpt-5.6-luna",
      output: [{ type: "web_search_call" }, { type: "message" }],
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
        output_tokens: 80,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 200,
      },
    } as unknown as OpenAI.Responses.Response;

    await observeOpenAiRequest("team_chat", "gpt-5.6-luna", async () => response);

    const logged = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      event: "openai_usage",
      feature: "team_chat",
      actualModel: "gpt-5.6-luna",
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 80,
      reasoningTokens: 20,
      totalTokens: 200,
      webSearchCalls: 1,
    });
    expect(JSON.stringify(logged)).not.toContain("student");
    expect(JSON.stringify(logged)).not.toContain("teamId");
  });

  it("실패 로그에 오류 메시지나 학생 입력을 포함하지 않는다", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error("민감한 학생 입력"), { status: 429, code: "rate_limit_exceeded" });

    await expect(observeOpenAiRequest("team_chat", "gpt-5.6-luna", async () => {
      throw error;
    })).rejects.toThrow("민감한 학생 입력");

    const loggedText = String(warning.mock.calls[0]?.[0]);
    expect(loggedText).toContain("openai_failure");
    expect(loggedText).toContain("rate_limit_exceeded");
    expect(loggedText).not.toContain("민감한 학생 입력");
  });
});
