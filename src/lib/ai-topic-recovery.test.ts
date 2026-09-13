import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: mocks.parse };
  },
}));

import { generateTopicSuggestions } from "@/lib/ai";
import { getDb } from "@/lib/db";

beforeEach(() => mocks.parse.mockReset());
afterEach(() => vi.unstubAllEnvs());

it("rejects an old displayed cycle before generating directions", async () => {
  await expect(generateTopicSuggestions("demo_session_1", "demo_team_1", "옛 관심사", "demo_student_1", undefined, "old_cycle")).rejects.toThrow(/회차/);
  expect(mocks.parse).not.toHaveBeenCalled();
});

it("recovers a failed topic request and reuses its completed result", async () => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  const output = {
    directions: Array.from({ length: 3 }, (_, index) => ({
      title: `방향 ${index + 1}`,
      reason: "측정 가능한 차이를 비교할 수 있습니다.",
      relation: "통합과학의 물질 변화와 연결됩니다.",
      candidateQuestion: `조건 ${index + 1}에 따라 측정값이 달라지는가?`,
      variables: ["독립 변인", "종속 변인"],
      feasibility: "학교에서 수행할 수 있습니다.",
      safetyNote: "보호구를 착용합니다.",
    })),
  };
  const requestId = "b4b79c5e-a99c-43ec-bdca-5828fca62008";
  mocks.parse.mockRejectedValueOnce(new Error("synthetic interrupted"));
  await expect(generateTopicSuggestions("demo_session_1", "demo_team_1", "재시도할 관심사", "demo_student_1", requestId)).rejects.toThrow();
  mocks.parse.mockResolvedValueOnce({ output_parsed: output, output: [], model: "synthetic" });
  await expect(generateTopicSuggestions("demo_session_1", "demo_team_1", "재시도할 관심사", "demo_student_1", requestId)).resolves.toEqual(output);
  await expect(generateTopicSuggestions("demo_session_1", "demo_team_1", "재시도할 관심사", "demo_student_1", requestId)).resolves.toEqual(output);
  expect(mocks.parse).toHaveBeenCalledTimes(2);
  const db = await getDb();
  expect((await db.query("SELECT stage FROM inquiry_sessions WHERE id = 'demo_session_1'")).rows[0].stage).toBe("EXPERIMENTING");
  const jobs = await db.query("SELECT status, attempt_count FROM ai_generation_jobs WHERE feature = 'topic_suggestions'");
  expect(jobs.rows).toContainEqual({ status: "completed", attempt_count: 2 });
});
