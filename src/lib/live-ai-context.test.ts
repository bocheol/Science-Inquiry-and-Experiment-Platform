import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), inquiry: vi.fn(), discussion: vi.fn(), redactor: vi.fn() }));
vi.mock("@/lib/discussions", async original => ({
  ...await original<typeof import("@/lib/discussions")>(),
  assertDiscussionAccess: mocks.access,
  getDiscussionData: mocks.discussion,
}));
vi.mock("@/lib/inquiry-data", () => ({ getInquiryDataForTeam: mocks.inquiry }));
vi.mock("@/lib/student-privacy", () => ({ studentTextRedactor: mocks.redactor }));
import { buildLiveAiSessionContext } from "@/lib/live-ai";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue("team");
  mocks.redactor.mockResolvedValue({ redact: (value: string) => value.replaceAll("홍길동", "참여자-가명") });
  mocks.discussion.mockResolvedValue({ history: [{ activityDate: "2026-09-12", items: [{ category: "next", text: "온도 재측정", sourceIds: [] }] }] });
  mocks.inquiry.mockResolvedValue({
    session: { id: "session", selectedTopic: "효소 반응", cycle: { id: "cycle", title: "1회차", status: "active" } },
    plan: { fields: [{ id: "method", label: "방법", kind: "long_text" }], formData: { method: "홍길동이 온도 측정" }, teacherFeedback: "대조군 확인" },
    report: { fields: [{ id: "analysis", label: "분석", kind: "long_text" }], formData: { analysis: "아직 없음" }, teacherFeedback: null },
  });
});

it("builds live context only from team documents, feedback, and shared activity summaries", async () => {
  const result = await buildLiveAiSessionContext({ id: "student", name: "학생", loginId: "s", role: "student", academicYear: 2026, classId: null, classNumber: null, mustChangePassword: false }, "session", "cycle");
  expect(result.instructions).toContain("최신 팀 계획서");
  expect(result.instructions).toContain("대조군 확인");
  expect(result.instructions).toContain("온도 재측정");
  expect(result.instructions).toContain("참여자-가명");
  expect(result.instructions).not.toContain("홍길동");
  expect(result.instructions).not.toContain("experiment_journals");
});
