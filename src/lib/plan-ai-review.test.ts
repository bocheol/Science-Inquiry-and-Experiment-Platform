import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { requestStudentPlanAiReview, requestTeacherPlanAiReview, type PlanReviewResult } from "@/lib/plan-ai-review";
import { getLatestPlanSubmission, getPlanSnapshot } from "@/lib/plan-snapshots";
import { reviewPlan, savePlanField, submitPlan } from "@/lib/plan-service";
import { updateCycleSettings } from "@/lib/cycle-settings";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";

const teamId = "plan_ai_review_team";
const sessionId = "plan_ai_review_session";
const planId = "plan_ai_review_plan";

const result: PlanReviewResult = {
  readiness: "needs_revision",
  summary: "측정 방법을 조금 더 확인해야 합니다.",
  strengths: [{ fieldKeys: ["topic"], feedback: "주제가 측정 가능한 현상에 초점을 두고 있습니다." }],
  checks: [{
    category: "feasibility",
    priority: "required",
    fieldKeys: ["method"],
    observation: "측정 간격이 적혀 있지 않습니다.",
    question: "얼마나 자주 측정할 수 있나요?",
    suggestion: "팀이 수행 가능한 측정 간격을 정해 보세요.",
  }],
  limitations: ["실험실 기구의 실제 보유 여부는 확인할 수 없습니다."],
};

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_9', 72, 'AI검토시험조', 'demo_student_1')",
    [teamId],
  );
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ('plan_ai_review_member', $1, 'demo_student_1')", [teamId]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $2, 'PLANNING')", [sessionId, teamId]);
  const cycleId = await ensureInitialCycle(db, sessionId, "teacher_bootstrap");
  await db.query(
    `INSERT INTO investigation_plans (id, session_id, cycle_id, form_data)
     VALUES ($1, $2, $3, $4)`,
    [planId, sessionId, cycleId, JSON.stringify({
      field: "화학", topic: "온도와 용해도", motivation: "생활 속 차이를 관찰했다.",
      purpose: "온도에 따른 차이를 비교한다.", method: "온도를 바꾸어 측정한다.", expectedResult: "차이가 있을 것이다.",
    })],
  );
});

describe("cycle-bound plan snapshots and AI review", () => {
  it("reuses a student review for the same saved document and creates a new one after an edit", async () => {
    const generate = vi.fn().mockResolvedValue({ result, model: "synthetic-plan-review" });
    const first = await requestStudentPlanAiReview(planId, "demo_student_1", generate);
    const repeated = await requestStudentPlanAiReview(planId, "demo_student_1", generate);
    expect(repeated.id).toBe(first.id);
    expect(generate).toHaveBeenCalledTimes(1);

    await savePlanField(planId, "method", "온도를 10도 간격으로 바꾸어 세 번 측정한다.", "demo_student_1", "온도를 바꾸어 측정한다.");
    const revised = await requestStudentPlanAiReview(planId, "demo_student_1", generate);
    expect(revised.snapshotId).not.toBe(first.snapshotId);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps each submitted document immutable and makes the teacher AI use only the latest fixed submission", async () => {
    await submitPlan(planId, "demo_student_1");
    const db = await getDb();
    const firstSubmission = await getLatestPlanSubmission(db, planId);
    expect(firstSubmission).toMatchObject({ submissionNumber: 1, source: "submission", reviewStatus: "pending" });
    const firstSnapshot = await getPlanSnapshot(db, firstSubmission!.snapshotId);
    await updateCycleSettings({
      cycleId: firstSubmission!.cycleId!,
      title: "다음 안내 이름",
      startDate: "2026-09-15",
      endDate: null,
      teacherId: "teacher_bootstrap",
    });
    expect((await getPlanSnapshot(db, firstSubmission!.snapshotId))?.cycleDefinition).toEqual(firstSnapshot?.cycleDefinition);

    await savePlanField(
      planId,
      "method",
      "온도를 5도 간격으로 바꾸어 네 번 측정한다.",
      "demo_student_1",
      "온도를 10도 간격으로 바꾸어 세 번 측정한다.",
    );
    expect((await getLatestPlanSubmission(db, planId))?.reviewStatus).toBe("withdrawn");
    expect((await getPlanSnapshot(db, firstSubmission!.snapshotId))?.formData).toEqual(firstSnapshot?.formData);
    await expect(requestTeacherPlanAiReview(planId, "teacher_bootstrap", vi.fn())).rejects.toThrow("제출한 최신 계획서");

    await submitPlan(planId, "demo_student_1");
    const generate = vi.fn().mockImplementation(async ({ snapshot }) => {
      expect(snapshot.formData.method).toBe("온도를 5도 간격으로 바꾸어 네 번 측정한다.");
      return { result, model: "synthetic-teacher-review" };
    });
    const teacherReview = await requestTeacherPlanAiReview(planId, "teacher_bootstrap", generate);
    const repeated = await requestTeacherPlanAiReview(planId, "teacher_bootstrap", generate);
    expect(repeated.id).toBe(teacherReview.id);
    expect(generate).toHaveBeenCalledTimes(1);

    await reviewPlan(planId, "teacher_bootstrap", "approved", "");
    expect(await getLatestPlanSubmission(db, planId)).toMatchObject({ submissionNumber: 2, reviewStatus: "approved" });
  });

  it("blocks a student outside the team from reviewing the plan", async () => {
    await expect(requestStudentPlanAiReview(planId, "demo_student_2", vi.fn())).rejects.toThrow("접근할 수 없습니다");
  });

  it("rejects feedback for a superseded submission and preserves the latest document", async () => {
    const db = await getDb();
    const previous = await getLatestPlanSubmission(db, planId);
    await savePlanField(planId, "method", "반복 측정 방법을 다시 정했다.", "demo_student_1", "온도를 5도 간격으로 바꾸어 네 번 측정한다.");
    await submitPlan(planId, "demo_student_1");
    const latest = await getLatestPlanSubmission(db, planId);
    const expected = { submissionId: latest!.id, cycleId: latest!.cycleId, status: "pending", feedback: "" };
    await expect(reviewPlan(planId, "teacher_bootstrap", "feedback", "오래된 내용", "", { ...expected, submissionId: previous!.id }))
      .rejects.toThrow("제출본이나 검토 상태가 변경");
    expect((await getLatestPlanSubmission(db, planId))?.reviewStatus).toBe("pending");
    await expect(reviewPlan(planId, "teacher_bootstrap", "feedback", "최신 보완 내용", "", expected)).resolves.toBeUndefined();
    expect(await getLatestPlanSubmission(db, planId)).toMatchObject({ id: latest!.id, reviewStatus: "feedback", teacherFeedback: "최신 보완 내용" });
    await expect(reviewPlan(planId, "teacher_bootstrap", "feedback", "다른 교사의 오래된 내용", "", expected)).rejects.toThrow("제출본이나 검토 상태가 변경");
  });
});
