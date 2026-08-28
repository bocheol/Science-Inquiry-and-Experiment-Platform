import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { getDocumentHistory, restorePlanRevision, restoreReportRevision } from "@/lib/document-history";
import { createId } from "@/lib/id";
import { savePlanField } from "@/lib/plan-service";
import { saveReportField, saveReportMemberRole } from "@/lib/report-service";

const leaderId = "history_current_leader";
const memberId = "history_general_member";
const formerLeaderId = "history_former_leader";
const teamId = "history_team";
const sessionId = "history_session";
const planId = "history_plan";
const reportId = "history_report";

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '현재 팀장', 'history-leader', 2026, 'student', 'class_2026_7', 'unused', FALSE),
            ($2, '일반 팀원', 'history-member', 2026, 'student', 'class_2026_7', 'unused', FALSE),
            ($3, '이전 팀장', 'history-former', 2026, 'student', 'class_2026_7', 'unused', FALSE)`,
    [leaderId, memberId, formerLeaderId],
  );
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_7', 96, '이력복원시험조', $2)",
    [teamId, leaderId],
  );
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $2, 'PLANNING')", [sessionId, teamId]);
  await db.query("INSERT INTO investigation_plans (id, session_id) VALUES ($1, $2)", [planId, sessionId]);
  await db.query("INSERT INTO reports (id, session_id) VALUES ($1, $2)", [reportId, sessionId]);
  for (const userId of [leaderId, memberId, formerLeaderId]) {
    await db.query("INSERT INTO team_members (id, team_id, user_id, status) VALUES ($1, $2, $3, 'active')", [createId("member"), teamId, userId]);
  }
});

describe("plan and report revision restore permissions", () => {
  it("records plan changes and allows only the current leader or teacher to restore", async () => {
    await savePlanField(planId, "topic", "처음 주제", leaderId);
    await savePlanField(planId, "topic", "바뀐 주제", memberId);
    const history = await getDocumentHistory("plan", planId);
    expect(history.filter((revision) => revision.action === "field:topic")).toHaveLength(2);
    const db = await getDb();
    const firstTopicRevision = await db.query<{ id: string }>(
      `SELECT id FROM document_revisions
        WHERE document_type = 'plan' AND document_id = $1 AND action = 'field:topic'
          AND snapshot->'formData'->>'topic' = '처음 주제' LIMIT 1`,
      [planId],
    );
    expect(firstTopicRevision.rows[0]?.id).toBeTruthy();

    await expect(restorePlanRevision(planId, firstTopicRevision.rows[0]!.id, memberId)).rejects.toThrow("현재 팀장");
    await expect(restorePlanRevision(planId, firstTopicRevision.rows[0]!.id, formerLeaderId)).rejects.toThrow("현재 팀장");
    await restorePlanRevision(planId, firstTopicRevision.rows[0]!.id, leaderId);

    const restored = await db.query<{ topic: string | null; selected_topic: string | null }>(
      `SELECT p.form_data->>'topic' AS topic, s.selected_topic
         FROM investigation_plans p JOIN inquiry_sessions s ON s.id = p.session_id WHERE p.id = $1`,
      [planId],
    );
    expect(restored.rows[0]).toMatchObject({ topic: "처음 주제", selected_topic: "처음 주제" });

    await savePlanField(planId, "topic", "교사 복원 전", leaderId);
    await expect(restorePlanRevision(planId, firstTopicRevision.rows[0]!.id, "teacher_bootstrap")).resolves.toBeUndefined();
  });

  it("restores report fields and roles while blocking a general member", async () => {
    await saveReportField(reportId, "purpose", "처음 목적", leaderId);
    await saveReportMemberRole(reportId, leaderId, "실험 설계", leaderId);
    await saveReportField(reportId, "purpose", "바뀐 목적", memberId);
    const db = await getDb();
    const revision = await db.query<{ id: string }>(
      `SELECT id FROM document_revisions
        WHERE document_type = 'report' AND document_id = $1
          AND action = 'field:purpose'
          AND snapshot->'formData'->>'purpose' = '처음 목적'
        ORDER BY created_at DESC LIMIT 1`,
      [reportId],
    );
    expect(revision.rows[0]?.id).toBeTruthy();
    await expect(restoreReportRevision(reportId, revision.rows[0]!.id, memberId)).rejects.toThrow("현재 팀장");
    await restoreReportRevision(reportId, revision.rows[0]!.id, leaderId);

    const restored = await db.query<{ purpose: string }>("SELECT form_data->>'purpose' AS purpose FROM reports WHERE id = $1", [reportId]);
    const roles = await db.query<{ role_description: string }>("SELECT role_description FROM report_member_roles WHERE report_id = $1 AND user_id = $2", [reportId, leaderId]);
    expect(restored.rows[0]?.purpose).toBe("처음 목적");
    expect(roles.rows[0]?.role_description).toBe("실험 설계");
  });
});
