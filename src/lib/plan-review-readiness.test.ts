import { expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { getInquiryDataForUser } from "@/lib/inquiry-data";
import { getLatestPlanSubmission, getPlanSnapshot } from "@/lib/plan-snapshots";
import { requestStudentPlanAiReview, requestTeacherPlanAiReview, type PlanReviewResult } from "@/lib/plan-ai-review";
import { savePlanField, submitPlan } from "@/lib/plan-service";
import { updateCycleSettings } from "@/lib/cycle-settings";
import { POST } from "@/app/api/teacher/plans/review/route";

vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "teacher_bootstrap", role: "teacher", mustChangePassword: false }) }));
vi.mock("@/lib/push-notifications", () => ({ sendPushForNotice: vi.fn() }));

const result: PlanReviewResult = {
  readiness: "needs_revision", summary: "측정 기준을 확인하세요.", strengths: [], limitations: [],
  checks: [{ category: "missing", priority: "required", fieldKeys: ["method"], observation: "측정 간격이 없습니다.",
    question: "얼마나 자주 측정하나요?", suggestion: "측정 간격을 정해 주세요." }],
};
let number = 100;
async function fixture() {
  const db = await getDb();
  const id = `plan_readiness_${++number}`;
  await db.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ($1, 'class_2026_9', $2, '합성검토팀')", [id, number]);
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $1, 'demo_student_1')", [id]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $1, 'PLANNING')", [id]);
  const cycleId = await ensureInitialCycle(db, id, "teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id, form_data) VALUES ($1, $1, $2, $3)",
    [id, cycleId, JSON.stringify({ field: "화학", topic: "온도 비교", motivation: "관찰", purpose: "차이 비교", method: "측정", expectedResult: "차이" })]);
  return { db, id, cycleId };
}

it("keeps a fresh student review current and invalidates it only after saved evidence changes", async () => {
  const f = await fixture();
  const generate = vi.fn().mockResolvedValue({ result, model: "synthetic-only" });
  const review = await requestStudentPlanAiReview(f.id, "demo_student_1", generate);
  const snapshot = await getPlanSnapshot(f.db, review.snapshotId);
  expect((await getInquiryDataForUser("demo_student_1", f.id))?.plan.studentAiReview?.isCurrent).toBe(true);
  await savePlanField(f.id, "method", "측정", "demo_student_1", "측정");
  expect((await getInquiryDataForUser("demo_student_1", f.id))?.plan.studentAiReview?.isCurrent).toBe(true);
  await savePlanField(f.id, "method", "세 번 측정", "demo_student_1", "측정");
  expect((await getInquiryDataForUser("demo_student_1", f.id))?.plan.studentAiReview?.isCurrent).toBe(false);
  await requestStudentPlanAiReview(f.id, "demo_student_1", generate);
  expect((await getInquiryDataForUser("demo_student_1", f.id))?.plan.studentAiReview?.isCurrent).toBe(true);
  await updateCycleSettings({ cycleId: f.cycleId, teacherId: "teacher_bootstrap", title: "변경된 안내", startDate: null, endDate: null });
  expect((await getInquiryDataForUser("demo_student_1", f.id))?.plan.studentAiReview?.isCurrent).toBe(false);
  expect(await getPlanSnapshot(f.db, review.snapshotId)).toEqual(snapshot);
});

it("reviews the submitted snapshot, rejects missing or stale expectations, then supports revision and approval", async () => {
  const f = await fixture();
  const send = (body: object) => POST(new Request("http://localhost/api/teacher/plans/review", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  await submitPlan(f.id, "demo_student_1");
  const first = (await getLatestPlanSubmission(f.db, f.id))!;
  const expected = { submissionId: first.id, cycleId: f.cycleId, status: "pending", feedback: "" };
  const base = { action: "review", planId: f.id, decision: "approved", feedback: "" };
  expect((await send(base)).status).toBe(400);
  await savePlanField(f.id, "method", "측정 간격도 기록", "demo_student_1", "측정");
  await submitPlan(f.id, "demo_student_1");
  expect((await send({ ...base, expected })).status).toBe(400);
  expect((await getLatestPlanSubmission(f.db, f.id))?.reviewStatus).toBe("pending");
  const second = (await getLatestPlanSubmission(f.db, f.id))!;
  const generate = vi.fn().mockResolvedValue({ result, model: "synthetic-only" });
  const ai = await requestTeacherPlanAiReview(f.id, "teacher_bootstrap", generate);
  expect(ai.snapshotId).toBe(second.snapshotId);
  expect((await send({ ...base, decision: "feedback", feedback: "간격을 보완해 주세요.", expected: { ...expected, submissionId: second.id } })).status).toBe(200);
  expect((await getLatestPlanSubmission(f.db, f.id))?.reviewStatus).toBe("feedback");
  const feedbackExpected = { ...expected, submissionId: second.id, status: "feedback", feedback: "간격을 보완해 주세요." };
  expect((await requestTeacherPlanAiReview(f.id, "teacher_bootstrap", generate)).snapshotId).toBe(second.snapshotId);
  expect((await send({ ...base, decision: "feedback", feedback: "간격과 반복 횟수를 보완해 주세요.", expected: feedbackExpected })).status).toBe(200);
  expect((await getLatestPlanSubmission(f.db, f.id))?.teacherFeedback).toBe("간격과 반복 횟수를 보완해 주세요.");
  expect((await send({ ...base, decision: "feedback", feedback: "오래된 화면의 덮어쓰기", expected: feedbackExpected })).status).toBe(400);
  expect((await send({ ...base, expected: { ...feedbackExpected, feedback: "간격과 반복 횟수를 보완해 주세요." } })).status).toBe(400);
  await savePlanField(f.id, "method", "5분마다 세 번 측정", "demo_student_1");
  await submitPlan(f.id, "demo_student_1");
  const third = (await getLatestPlanSubmission(f.db, f.id))!;
  expect((await send({ ...base, decision: "feedback", feedback: "이전 제출본", expected: { ...feedbackExpected, feedback: "간격과 반복 횟수를 보완해 주세요." } })).status).toBe(400);
  expect((await send({ ...base, expected: { ...expected, submissionId: third.id } })).status).toBe(200);
  expect((await getLatestPlanSubmission(f.db, f.id))?.reviewStatus).toBe("approved");
  expect((await getPlanSnapshot(f.db, first.snapshotId))?.formData.method).toBe("측정");
});
