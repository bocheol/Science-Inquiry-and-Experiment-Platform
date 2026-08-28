import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { getInquiryDataForTeam } from "@/lib/inquiry-data";
import {
  assertStudentReportAccess,
  lockReportField,
  releaseReportField,
  reviewReport,
  saveReportField,
  saveReportMemberRole,
  submitReport,
} from "@/lib/report-service";

const teamId = "report_test_team";
const sessionId = "report_test_session";
const reportId = "report_test_report";
const ownerId = "report_test_owner";
const peerId = "report_test_peer";

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '보고서 작성자', 'report-owner', 2026, 'student', 'class_2026_1', 'unused', FALSE),
            ($2, '보고서 팀원', 'report-peer', 2026, 'student', 'class_2026_1', 'unused', FALSE)`,
    [ownerId, peerId],
  );
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_1', 97, '보고서시험조', $2)",
    [teamId, ownerId],
  );
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage, selected_topic) VALUES ($1, $2, 'EXPERIMENTING', '용액 색 변화 탐구')", [sessionId, teamId]);
  await db.query("INSERT INTO investigation_plans (id, session_id, review_status) VALUES ('report_test_plan', $1, 'approved')", [sessionId]);
  await db.query("INSERT INTO reports (id, session_id) VALUES ($1, $2)", [reportId, sessionId]);
  await db.query(
    `INSERT INTO team_members (id, team_id, user_id, status) VALUES
      ($1, $2, $3, 'active'), ($4, $2, $5, 'active')`,
    [createId("member"), teamId, ownerId, createId("member"), peerId],
  );
});

describe("team report collaboration and access", () => {
  it("locks one field to one active member at a time", async () => {
    await lockReportField(reportId, "purpose", { id: ownerId, name: "보고서 작성자" });
    await expect(lockReportField(reportId, "purpose", { id: peerId, name: "보고서 팀원" })).rejects.toThrow("작성 중입니다");
    await releaseReportField(reportId, "purpose", ownerId);
    await expect(lockReportField(reportId, "purpose", { id: peerId, name: "보고서 팀원" })).resolves.toBeUndefined();
    await releaseReportField(reportId, "purpose", peerId);
  });

  it("keeps saves to different fields when teammates finish together", async () => {
    await Promise.all([
      saveReportField(reportId, "purpose", "동시 저장 목적", ownerId),
      saveReportField(reportId, "terms", "동시 저장 용어", peerId),
    ]);
    const db = await getDb();
    const result = await db.query<{ field_key: string; value: string }>("SELECT field_key, value FROM report_fields WHERE report_id = $1", [reportId]);
    expect(Object.fromEntries(result.rows.map((row) => [row.field_key, row.value]))).toMatchObject({ purpose: "동시 저장 목적", terms: "동시 저장 용어" });
  });

  it("requires every school-form section and active member role, then supports teacher feedback", async () => {
    await assertStudentReportAccess(ownerId, reportId);
    const fields = {
      purpose: "연구 목적",
      terms: "용어 정의",
      background: "이론적 배경",
      researchPlanSchedule: "연구 일정",
      experimentMethod: "실험 과정",
      data: "측정 자료",
      analysis: "결과 분석",
      conclusion: "결론",
      references: "참고문헌",
    };
    for (const [key, value] of Object.entries(fields)) await saveReportField(reportId, key, value, ownerId);
    await expect(submitReport(reportId, ownerId)).rejects.toThrow("팀원 모두의 역할");
    await saveReportMemberRole(reportId, ownerId, "실험 설계", ownerId);
    await saveReportMemberRole(reportId, peerId, "측정 및 자료 정리", ownerId);
    await submitReport(reportId, ownerId);

    const db = await getDb();
    const submitted = await db.query<{ status: string; title: string; stage: string }>(
      `SELECT r.status, r.form_data->>'title' AS title, s.stage
         FROM reports r JOIN inquiry_sessions s ON s.id = r.session_id WHERE r.id = $1`,
      [reportId],
    );
    expect(submitted.rows[0]).toMatchObject({ status: "submitted", title: "용액 색 변화 탐구", stage: "REPORTING" });

    await reviewReport(reportId, "teacher_bootstrap", "feedback", "고찰에 오차 원인을 보완하세요.");
    expect((await db.query<{ status: string }>("SELECT status FROM reports WHERE id = $1", [reportId])).rows[0]?.status).toBe("feedback");
    await saveReportField(reportId, "analysis", "오차 원인을 포함한 결과 분석", ownerId);
    await submitReport(reportId, ownerId);
    await reviewReport(reportId, "teacher_bootstrap", "reviewed", "");
    expect((await db.query<{ status: string }>("SELECT status FROM reports WHERE id = $1", [reportId])).rows[0]?.status).toBe("reviewed");
  });

  it("blocks removed students while retaining their saved role", async () => {
    const db = await getDb();
    await db.query("UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE team_id = $1 AND user_id = $2", [teamId, peerId]);
    await expect(assertStudentReportAccess(peerId, reportId)).rejects.toThrow("접근할 수 없습니다");
    const role = await db.query<{ role_description: string }>("SELECT role_description FROM report_member_roles WHERE report_id = $1 AND user_id = $2", [reportId, peerId]);
    expect(role.rows[0]?.role_description).toBe("측정 및 자료 정리");
    const teacherView = await getInquiryDataForTeam(teamId);
    expect(teacherView?.report.roles.find((item) => item.userId === peerId)).toMatchObject({ isActive: false, description: "측정 및 자료 정리" });
  });
});
