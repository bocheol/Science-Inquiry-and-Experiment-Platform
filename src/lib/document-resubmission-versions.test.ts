import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { PLAN_FIELDS, REPORT_FIELDS } from "@/lib/constants";
import { reviewPlan, submitPlan } from "@/lib/plan-service";
import { reviewReport, saveReportField, submitReport } from "@/lib/report-service";
import { compareDocumentVersions, pairPlanReviewRounds, pairReportReviewRounds } from "@/lib/document-version-reader";

vi.mock("@/lib/push-notifications", () => ({ sendPushForNotice: vi.fn() }));

const ids = {
  student: "resubmission_version_student",
  team: "resubmission_version_team",
  session: "resubmission_version_session",
  plan: "resubmission_version_plan",
  report: "resubmission_version_report",
};
const teacher = { id: "teacher_bootstrap", role: "teacher" as const };
let cycleId = "";

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '재제출 비교 학생', $1, 2026, 'student', 'class_2026_7', 'unused', FALSE)`,
    [ids.student],
  );
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_7', 970, '재제출 비교팀', $2)",
    [ids.team, ids.student],
  );
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $2, $3)", [`${ids.team}_member`, ids.team, ids.student]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $2, 'EXPERIMENTING')", [ids.session, ids.team]);
  cycleId = await ensureInitialCycle(db, ids.session, "teacher_bootstrap");

  const planForm = Object.fromEntries(PLAN_FIELDS.map(field => [field.key, field.key === "schedule" ? [] : `처음 ${field.label}`]));
  await db.query(
    "INSERT INTO investigation_plans (id, session_id, cycle_id, form_data) VALUES ($1, $2, $3, $4)",
    [ids.plan, ids.session, cycleId, JSON.stringify(planForm)],
  );
  await submitPlan(ids.plan, ids.student, cycleId);
  await reviewPlan(ids.plan, "teacher_bootstrap", "feedback", "탐구 방법에 반복 횟수를 명시해 주세요.");
  await db.query(
    "UPDATE investigation_plans SET form_data = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    [ids.plan, JSON.stringify({ ...planForm, method: "수정한 방법: 같은 조건에서 3회 반복 측정" })],
  );
  await submitPlan(ids.plan, ids.student, cycleId);

  const reportForm = Object.fromEntries(["title", ...REPORT_FIELDS.map(field => field.key)].map(key => [key, `처음 ${key}`]));
  await db.query(
    "INSERT INTO reports (id, session_id, cycle_id, form_data) VALUES ($1, $2, $3, $4)",
    [ids.report, ids.session, cycleId, JSON.stringify(reportForm)],
  );
  await db.query(
    "INSERT INTO report_member_roles (report_id, user_id, role_description) VALUES ($1, $2, '반복 측정과 결과 정리')",
    [ids.report, ids.student],
  );
  await submitReport(ids.report, ids.student, cycleId);
  await reviewReport(ids.report, "teacher_bootstrap", "feedback", "분석에서 오차 원인을 설명해 주세요.");
  await saveReportField(ids.report, "analysis", "수정한 분석: 측정 기구의 눈금 한계를 오차 원인으로 설명", ids.student, undefined, cycleId);
  await submitReport(ids.report, ids.student, cycleId);
});

describe("feedback to resubmission version pairs", () => {
  it("does not present a withdrawn plan submission as the completed resubmission", () => {
    const base = {
      source: "submission", teacher_feedback: null, reviewed_at: null,
      submitted_at: "2026-09-01T00:00:00Z", actor_name: "합성 학생",
    };
    const rounds = pairPlanReviewRounds([
      { ...base, id: "first", submission_number: 1, review_status: "feedback", teacher_feedback: "다시 작성", reviewed_at: "2026-09-01T01:00:00Z" },
      { ...base, id: "withdrawn", submission_number: 2, review_status: "withdrawn" },
      { ...base, id: "latest", submission_number: 3, review_status: "pending" },
    ]);
    expect(rounds[0]?.resubmission?.ref).toEqual({ kind: "submission", id: "latest" });
  });

  it("pairs immutable plan submissions and compares the submitted contents", async () => {
    const scope = { documentType: "plan" as const, documentId: ids.plan, cycleId };
    const db = await getDb();
    const submissions = (await db.query(
      `SELECT ps.id, ps.submission_number, ps.source, ps.review_status, ps.teacher_feedback,
              ps.submitted_at, ps.reviewed_at, u.name AS actor_name
         FROM plan_submissions ps JOIN users u ON u.id = ps.submitted_by
        WHERE ps.plan_id = $1 AND ps.cycle_id = $2 ORDER BY ps.submission_number`,
      [ids.plan, cycleId],
    )).rows;
    const rounds = pairPlanReviewRounds(submissions);
    expect(rounds).toHaveLength(1);
    const round = rounds[0]!;
    expect(round.feedback).toBe("탐구 방법에 반복 횟수를 명시해 주세요.");
    expect(round.source.ref.kind).toBe("submission");
    expect(round.resubmission?.ref.kind).toBe("submission");
    const comparison = await compareDocumentVersions(teacher, scope, round.source.ref, round.resubmission!.ref);
    expect(comparison.a.values.method).toBe("처음 구체적인 탐구 방법");
    expect(comparison.b.values.method).toBe("수정한 방법: 같은 조건에서 3회 반복 측정");
  });

  it("pairs the report feedback snapshot with the next explicit submit event", async () => {
    const scope = { documentType: "report" as const, documentId: ids.report, cycleId };
    const db = await getDb();
    // PostgreSQL CURRENT_TIMESTAMP is fixed for a transaction, while pg-mem advances it
    // for each statement. Recreate the production transaction-time invariant here.
    const feedbackRevision = (await db.query<{ id: string }>(
      "SELECT id FROM document_revisions WHERE document_type = 'report' AND document_id = $1 AND action = 'teacher_feedback' ORDER BY created_at DESC LIMIT 1",
      [ids.report],
    )).rows[0]!;
    const submits = (await db.query<{ id: string; snapshot: { formData?: { analysis?: string } } | string }>(
      "SELECT id, snapshot FROM document_revisions WHERE document_type = 'report' AND document_id = $1 AND action = 'submit'",
      [ids.report],
    )).rows;
    const isResubmission = (row: typeof submits[number]) => {
      const snapshot = typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot;
      return snapshot.formData?.analysis === "수정한 분석: 측정 기구의 눈금 한계를 오차 원인으로 설명";
    };
    const resubmission = submits.find(isResubmission)!;
    const firstSubmission = submits.find(row => row.id !== resubmission.id)!;
    await db.query("UPDATE document_revisions SET created_at = $2 WHERE id = $1", [firstSubmission.id, "2026-09-01T00:00:00Z"]);
    await db.query("UPDATE document_revisions SET created_at = $2 WHERE id = $1", [feedbackRevision.id, "2026-09-01T00:01:00Z"]);
    await db.query("UPDATE document_revisions SET created_at = $2 WHERE id = $1", [resubmission.id, "2026-09-01T00:02:00Z"]);
    await db.query(
      "UPDATE notices SET created_at = $2 WHERE kind = 'action_request' AND source_type = 'report' AND source_id = $1",
      [ids.report, "2026-09-01T00:01:00Z"],
    );
    const reviewRows = (await db.query(
      `SELECT dr.id, dr.action, dr.snapshot, dr.created_at, u.name AS actor_name
         FROM document_revisions dr JOIN users u ON u.id = dr.changed_by
        WHERE dr.document_type = 'report' AND dr.document_id = $1 AND dr.cycle_id = $2
          AND dr.action IN ('teacher_feedback', 'submit') ORDER BY dr.created_at, dr.id`,
      [ids.report, cycleId],
    )).rows;
    const notices = (await db.query(
      `SELECT id, content, created_at FROM notices
        WHERE kind = 'action_request' AND source_type = 'report' AND source_id = $1 ORDER BY created_at, id`,
      [ids.report],
    )).rows;
    const rounds = pairReportReviewRounds(reviewRows, notices);
    expect(rounds).toHaveLength(1);
    const round = rounds[0]!;
    expect(round.feedback).toBe("분석에서 오차 원인을 설명해 주세요.");
    expect(round.source.ref.kind).toBe("revision");
    expect(round.resubmission?.ref.kind).toBe("revision");
    const comparison = await compareDocumentVersions(teacher, scope, round.source.ref, round.resubmission!.ref);
    expect(comparison.a.values.analysis).toBe("처음 analysis");
    expect(comparison.b.values.analysis).toBe("수정한 분석: 측정 기구의 눈금 한계를 오차 원인으로 설명");
  });
});
