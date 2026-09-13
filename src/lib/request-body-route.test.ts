import { beforeEach, expect, it, vi } from "vitest";
import { JSON_BODY_MAX_BYTES } from "@/lib/request-body";

const state = vi.hoisted(() => ({
  user: { id: "synthetic-teacher", role: "teacher", mustChangePassword: false } as null | { id: string; role: string; mustChangePassword: boolean },
  generate: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/ai", () => ({ userFacingAiError: () => "안전한 합성 오류" }));
vi.mock("@/lib/exam-service", () => ({
  ExamServiceError: class extends Error { status = 400; },
  addCommonExamQuestion: vi.fn(), confirmExamSet: vi.fn(), createCorrectionExamSet: vi.fn(),
  deleteExamQuestionSlot: vi.fn(), generateExamSet: state.generate, getExamManagementData: vi.fn(),
  publishExamResult: vi.fn(), saveExamResult: vi.fn(), updateExamQuestion: vi.fn(),
}));
import { POST } from "@/app/api/teacher/exams/route";

beforeEach(() => {
  state.user = { id: "synthetic-teacher", role: "teacher", mustChangePassword: false };
  state.generate.mockReset().mockResolvedValue("synthetic-exam");
});

it("returns a safe 400 for malformed or oversized JSON before calling a service", async () => {
  const malformed = new Request("http://localhost/api/teacher/exams", { method: "POST", body: "{" });
  expect((await POST(malformed)).status).toBe(400);
  const oversized = new Request("http://localhost/api/teacher/exams", {
    method: "POST", headers: { "content-length": String(JSON_BODY_MAX_BYTES + 1) }, body: "{}",
  });
  expect((await POST(oversized)).status).toBe(400);
  expect(state.generate).not.toHaveBeenCalled();
});

it("keeps a normal authenticated JSON request working", async () => {
  const response = await POST(new Request("http://localhost/api/teacher/exams", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "generate", classNumber: 1, title: "합성 시험", commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 범위" }),
  }));
  expect(response.status).toBe(200);
  expect(state.generate).toHaveBeenCalledOnce();
});

it("rejects an unauthenticated request before reading its body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([123, 125])); }, cancel() { cancelled = true; } });
  const request = new Request("http://localhost/api/teacher/exams", { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
  state.user = null;
  expect((await POST(request)).status).toBe(403);
  expect(cancelled).toBe(false);
  expect(request.bodyUsed).toBe(false);
});
