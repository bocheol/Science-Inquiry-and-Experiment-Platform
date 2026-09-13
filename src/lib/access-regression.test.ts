import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), action: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/db", () => ({ getDb: mocks.action }));
vi.mock("@/lib/inquiry-data", () => ({ assertActiveTeamMember: mocks.action }));
vi.mock("@/lib/ai", () => ({ selectTopic: mocks.action, generateTopicSuggestions: mocks.action, userFacingAiError: () => "failed" }));
vi.mock("@/lib/plan-service", () => ({ selectTopic: mocks.action, lockPlanField: mocks.action, releasePlanField: mocks.action }));
vi.mock("@/lib/materials", () => ({ retryMaterialSync: mocks.action }));
vi.mock("@/lib/roster", () => ({ importRoster: mocks.action }));
vi.mock("@/lib/teacher-data", () => ({ getTeacherDashboardData: mocks.action }));
vi.mock("@/lib/teacher-export", () => ({ buildTeacherProgressExport: mocks.action }));
vi.mock("@/lib/exam-pdf", () => ({ buildExamPdf: mocks.action }));

import { POST as selectTopic } from "@/app/api/inquiry/topic-select/route";
import { POST as suggestTopic } from "@/app/api/inquiry/topic-suggestions/route";
import { POST as lockPlan } from "@/app/api/inquiry/plan/lock/route";
import { POST as retryMaterial } from "@/app/api/teacher/materials/retry/route";
import { GET as readRoster, POST as importRoster } from "@/app/api/teacher/roster/route";
import { GET as readExam, POST as createExam, PATCH as editExam, DELETE as deleteExam } from "@/app/api/teacher/exams/route";
import { GET as examPdf } from "@/app/api/teacher/exams/pdf/route";
import { GET as exportProgress } from "@/app/api/teacher/progress-export/route";
import { GET as studentExam } from "@/app/api/inquiry/exam/route";

afterEach(() => vi.clearAllMocks());

it.each([
  ["topic selection", "student", selectTopic],
  ["topic suggestions", "student", suggestTopic],
  ["plan lock", "student", lockPlan],
  ["material retry", "teacher", retryMaterial],
  ["roster read", "teacher", readRoster],
  ["roster import", "teacher", importRoster],
  ["exam read", "teacher", readExam],
  ["exam create", "teacher", createExam],
  ["exam edit", "teacher", editExam],
  ["exam delete", "teacher", deleteExam],
  ["exam PDF", "teacher", examPdf],
  ["progress export", "teacher", exportProgress],
  ["student exam", "student", studentExam],
] as const)("blocks %s before a required password change", async (_label, role, handler) => {
  mocks.user.mockResolvedValue({ id: "synthetic", role, mustChangePassword: true });
  const result = await handler(new Request("http://localhost/api", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  expect(result.status).toBe(403);
  expect(mocks.action).not.toHaveBeenCalled();
});

it("still permits a teacher who completed the password change to read the roster", async () => {
  mocks.user.mockResolvedValue({ id: "synthetic", role: "teacher", mustChangePassword: false });
  mocks.action.mockResolvedValue({ classes: [] });
  expect((await readRoster()).status).toBe(200);
  expect(mocks.action).toHaveBeenCalledOnce();
});
