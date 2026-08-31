import { audit, getDb } from "@/lib/db";
import { REPORT_FIELDS } from "@/lib/constants";
import { recordReportRevision } from "@/lib/document-history";
import { createActionNotice, resolveActionNotices } from "@/lib/notices";

const ALLOWED_FIELDS = new Set(["title", ...REPORT_FIELDS.map((field) => field.key)]);
const REPORT_STAGES = new Set(["EXPERIMENTING", "REPORTING", "EXAMINING", "EVALUATING", "COMPLETED"]);

function validLockKey(fieldKey: string) {
  return ALLOWED_FIELDS.has(fieldKey) || /^role:[A-Za-z0-9_-]{1,200}$/.test(fieldKey);
}

function parseFormData(value: Record<string, unknown> | string) {
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
}

export async function assertStudentReportAccess(userId: string, reportId: string) {
  const db = await getDb();
  const result = await db.query<{ session_id: string; team_id: string; stage: string }>(
    `SELECT r.session_id, s.team_id, s.stage
       FROM reports r
       JOIN inquiry_sessions s ON s.id = r.session_id
       JOIN team_members tm ON tm.team_id = s.team_id
       JOIN teams t ON t.id = s.team_id
      WHERE r.id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND t.status = 'active'`,
    [reportId, userId],
  );
  const report = result.rows[0];
  if (!report) throw new Error("현재 팀 보고서에 접근할 수 없습니다.");
  if (!REPORT_STAGES.has(report.stage)) throw new Error("탐구 계획 승인 후 보고서를 작성할 수 있습니다.");
  return report;
}

export async function lockReportField(reportId: string, fieldKey: string, user: { id: string; name: string }) {
  if (!validLockKey(fieldKey)) throw new Error("보고서 항목을 확인해 주세요.");
  const db = await getDb();
  const now = new Date();
  await db.query("DELETE FROM report_field_locks WHERE expires_at <= $1", [now]);
  const current = await db.query<{ user_id: string; user_name: string }>(
    "SELECT user_id, user_name FROM report_field_locks WHERE report_id = $1 AND field_key = $2",
    [reportId, fieldKey],
  );
  if (current.rows[0] && current.rows[0].user_id !== user.id) {
    throw new Error(`${current.rows[0].user_name} 학생이 작성 중입니다.`);
  }
  await db.query(
    `INSERT INTO report_field_locks (report_id, field_key, user_id, user_name, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (report_id, field_key) DO UPDATE
       SET user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, expires_at = EXCLUDED.expires_at`,
    [reportId, fieldKey, user.id, user.name, new Date(now.getTime() + 35_000)],
  );
}

export async function releaseReportField(reportId: string, fieldKey: string, userId: string) {
  const db = await getDb();
  await db.query(
    "DELETE FROM report_field_locks WHERE report_id = $1 AND field_key = $2 AND user_id = $3",
    [reportId, fieldKey, userId],
  );
}

async function assertWritableLock(reportId: string, fieldKey: string, userId: string) {
  const db = await getDb();
  const lock = await db.query<{ user_id: string; user_name: string }>(
    `SELECT user_id, user_name FROM report_field_locks
      WHERE report_id = $1 AND field_key = $2 AND expires_at > $3`,
    [reportId, fieldKey, new Date()],
  );
  if (lock.rows[0] && lock.rows[0].user_id !== userId) throw new Error(`${lock.rows[0].user_name} 학생이 작성 중입니다.`);
}

export async function saveReportField(reportId: string, fieldKey: string, value: string, userId: string) {
  if (!ALLOWED_FIELDS.has(fieldKey)) throw new Error("보고서 항목을 확인해 주세요.");
  await assertWritableLock(reportId, fieldKey, userId);
  const db = await getDb();
  const result = await db.query<{ status: string; form_data: Record<string, unknown> | string }>("SELECT status, form_data FROM reports WHERE id = $1", [reportId]);
  const report = result.rows[0];
  if (!report) throw new Error("보고서를 찾을 수 없습니다.");
  const saved = await db.query<{ value: string }>("SELECT value FROM report_fields WHERE report_id = $1 AND field_key = $2", [reportId, fieldKey]);
  const currentValue = saved.rows[0]?.value ?? String(parseFormData(report.form_data)[fieldKey] ?? "");
  if (currentValue === value) return;
  await recordReportRevision(db, reportId, userId, `field:${fieldKey}`);
  await db.query(
    `INSERT INTO report_fields (report_id, field_key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (report_id, field_key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [reportId, fieldKey, value],
  );
  const resetSubmission = report.status === "submitted" || report.status === "reviewed";
  await db.query(
    `UPDATE reports
        SET status = CASE WHEN $2 THEN 'draft' ELSE status END,
            submitted_at = CASE WHEN $2 THEN NULL ELSE submitted_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [reportId, resetSubmission],
  );
  await audit(userId, "report_field_saved", "report", reportId, { fieldKey });
}

export async function saveReportMemberRole(reportId: string, targetUserId: string, description: string, userId: string) {
  const fieldKey = `role:${targetUserId}`;
  await assertWritableLock(reportId, fieldKey, userId);
  const db = await getDb();
  const valid = await db.query(
    `SELECT 1 FROM reports r
       JOIN inquiry_sessions s ON s.id = r.session_id
       JOIN team_members tm ON tm.team_id = s.team_id
      WHERE r.id = $1 AND tm.user_id = $2`,
    [reportId, targetUserId],
  );
  if (!valid.rows[0]) throw new Error("보고서 팀원을 찾을 수 없습니다.");
  const existing = await db.query<{ role_description: string }>(
    "SELECT role_description FROM report_member_roles WHERE report_id = $1 AND user_id = $2",
    [reportId, targetUserId],
  );
  if ((existing.rows[0]?.role_description ?? "") === description) return;
  await recordReportRevision(db, reportId, userId, `role:${targetUserId}`);
  await db.query(
    `INSERT INTO report_member_roles (report_id, user_id, role_description)
     VALUES ($1, $2, $3)
     ON CONFLICT (report_id, user_id) DO UPDATE
       SET role_description = EXCLUDED.role_description, updated_at = CURRENT_TIMESTAMP`,
    [reportId, targetUserId, description],
  );
  await db.query(
    `UPDATE reports
        SET status = CASE WHEN status IN ('submitted', 'reviewed') THEN 'draft' ELSE status END,
            submitted_at = CASE WHEN status IN ('submitted', 'reviewed') THEN NULL ELSE submitted_at END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [reportId],
  );
  await audit(userId, "report_member_role_saved", "report", reportId, { targetUserId });
}

export async function submitReport(reportId: string, userId: string) {
  const db = await getDb();
  const result = await db.query<{
    form_data: Record<string, unknown> | string;
    selected_topic: string | null;
    team_id: string;
  }>(
    `SELECT r.form_data, s.selected_topic, s.team_id
       FROM reports r JOIN inquiry_sessions s ON s.id = r.session_id
      WHERE r.id = $1`,
    [reportId],
  );
  const report = result.rows[0];
  if (!report) throw new Error("보고서를 찾을 수 없습니다.");
  const formData = parseFormData(report.form_data);
  const savedFields = await db.query<{ field_key: string; value: string }>(
    "SELECT field_key, value FROM report_fields WHERE report_id = $1",
    [reportId],
  );
  for (const field of savedFields.rows) formData[field.field_key] = field.value;
  if (!String(formData.title ?? "").trim() && report.selected_topic) formData.title = report.selected_topic;
  const required = ["title", "purpose", "terms", "background", "researchPlanSchedule", "experimentMethod", "data", "analysis", "conclusion", "references"];
  if (required.some((key) => !String(formData[key] ?? "").trim())) throw new Error("부록을 제외한 보고서 항목을 모두 작성해 주세요.");
  const activeMembers = await db.query<{ count: string }>(
    "SELECT COUNT(DISTINCT user_id)::text AS count FROM team_members WHERE team_id = $1 AND status = 'active'",
    [report.team_id],
  );
  const completedRoles = await db.query<{ role_description: string }>(
    `SELECT rmr.role_description FROM report_member_roles rmr
       JOIN team_members tm ON tm.user_id = rmr.user_id
      WHERE rmr.report_id = $1 AND tm.team_id = $2 AND tm.status = 'active'`,
    [reportId, report.team_id],
  );
  if (Number(activeMembers.rows[0]?.count ?? 0) !== completedRoles.rows.filter((row) => row.role_description.trim()).length) {
    throw new Error("현재 팀원 모두의 역할을 작성해 주세요.");
  }
  await recordReportRevision(db, reportId, userId, "submit");
  await db.query(
    `UPDATE reports SET form_data = $1, status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [JSON.stringify(formData), reportId],
  );
  await db.query(
    `UPDATE inquiry_sessions SET stage = 'REPORTING', last_activity_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT session_id FROM reports WHERE id = $1) AND stage = 'EXPERIMENTING'`,
    [reportId],
  );
  await resolveActionNotices(db, "report", reportId);
  await audit(userId, "report_submitted", "report", reportId);
}

export async function reviewReport(reportId: string, teacherId: string, decision: "reviewed" | "feedback", feedback: string) {
  if (decision === "feedback" && !feedback.trim()) throw new Error("수정할 내용을 입력해 주세요.");
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ status: string; team_id: string }>(
      `SELECT r.status, s.team_id FROM reports r JOIN inquiry_sessions s ON s.id = r.session_id WHERE r.id = $1`,
      [reportId],
    );
    const current = result.rows[0];
    if (!current) throw new Error("보고서를 찾을 수 없습니다.");
    if (current.status !== "submitted" && current.status !== "reviewed") throw new Error("학생이 제출한 보고서만 검토할 수 있습니다.");
    await recordReportRevision(client, reportId, teacherId, decision === "reviewed" ? "teacher_review" : "teacher_feedback");
    const updated = await client.query(
      `UPDATE reports SET status = $1, teacher_feedback = $2, reviewed_by = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4 AND status = $5`,
      [decision, decision === "feedback" ? feedback.trim() : null, teacherId, reportId, current.status],
    );
    if (updated.rowCount !== 1) throw new Error("보고서 상태가 방금 변경되었습니다. 화면을 새로고침한 뒤 다시 확인해 주세요.");
    if (decision === "feedback") {
      await createActionNotice(client, { teacherId, teamId: current.team_id, sourceType: "report", sourceId: reportId, content: feedback });
    } else {
      await resolveActionNotices(client, "report", reportId);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, decision === "reviewed" ? "report_reviewed" : "report_feedback", "report", reportId);
}
