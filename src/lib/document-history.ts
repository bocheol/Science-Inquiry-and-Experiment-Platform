import type { PoolClient } from "pg";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";

type Queryable = Pick<PoolClient, "query">;
type DocumentType = "plan" | "report";

type PlanSnapshot = {
  formData: Record<string, unknown>;
  reviewStatus: string;
  teacherFeedback: string | null;
};

type ReportSnapshot = {
  formData: Record<string, unknown>;
  status: string;
  teacherFeedback: string | null;
  roles: Array<{ userId: string; description: string }>;
};

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function recordPlanRevision(db: Queryable, planId: string, actorId: string, action: string) {
  const result = await db.query<{
    form_data: Record<string, unknown> | string;
    review_status: string;
    teacher_feedback: string | null;
  }>("SELECT form_data, review_status, teacher_feedback FROM investigation_plans WHERE id = $1", [planId]);
  const row = result.rows[0];
  if (!row) throw new Error("계획서를 찾을 수 없습니다.");
  const snapshot: PlanSnapshot = {
    formData: parseJson(row.form_data, {}),
    reviewStatus: row.review_status,
    teacherFeedback: row.teacher_feedback,
  };
  await db.query(
    `INSERT INTO document_revisions (id, document_type, document_id, snapshot, action, changed_by)
     VALUES ($1, 'plan', $2, $3, $4, $5)`,
    [createId("revision"), planId, JSON.stringify(snapshot), action, actorId],
  );
}

export async function recordReportRevision(db: Queryable, reportId: string, actorId: string, action: string) {
  const result = await db.query<{
    form_data: Record<string, unknown> | string;
    status: string;
    teacher_feedback: string | null;
  }>("SELECT form_data, status, teacher_feedback FROM reports WHERE id = $1", [reportId]);
  const row = result.rows[0];
  if (!row) throw new Error("보고서를 찾을 수 없습니다.");
  const fields = await db.query<{ field_key: string; value: string }>(
    "SELECT field_key, value FROM report_fields WHERE report_id = $1",
    [reportId],
  );
  const formData = { ...parseJson(row.form_data, {}) };
  for (const field of fields.rows) formData[field.field_key] = field.value;
  const roles = await db.query<{ user_id: string; role_description: string }>(
    "SELECT user_id, role_description FROM report_member_roles WHERE report_id = $1 ORDER BY user_id",
    [reportId],
  );
  const snapshot: ReportSnapshot = {
    formData,
    status: row.status,
    teacherFeedback: row.teacher_feedback,
    roles: roles.rows.map((role) => ({ userId: role.user_id, description: role.role_description })),
  };
  await db.query(
    `INSERT INTO document_revisions (id, document_type, document_id, snapshot, action, changed_by)
     VALUES ($1, 'report', $2, $3, $4, $5)`,
    [createId("revision"), reportId, JSON.stringify(snapshot), action, actorId],
  );
}

export async function getDocumentHistory(documentType: DocumentType, documentId: string) {
  const db = await getDb();
  const result = await db.query<{
    id: string;
    action: string;
    actor_name: string;
    created_at: Date | string;
  }>(
    `SELECT dr.id, dr.action, u.name AS actor_name, dr.created_at
       FROM document_revisions dr JOIN users u ON u.id = dr.changed_by
      WHERE dr.document_type = $1 AND dr.document_id = $2
      ORDER BY dr.created_at DESC, dr.id DESC LIMIT 30`,
    [documentType, documentId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorName: row.actor_name,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

async function assertRestorePermission(db: Queryable, documentType: DocumentType, documentId: string, actorId: string) {
  const table = documentType === "plan" ? "investigation_plans" : "reports";
  const result = await db.query<{ role: string; leader_user_id: string | null; active_member: boolean }>(
    `SELECT u.role, t.leader_user_id, (tm.user_id IS NOT NULL) AS active_member
       FROM users u
       JOIN ${table} d ON d.id = $1
       JOIN inquiry_sessions s ON s.id = d.session_id
       JOIN teams t ON t.id = s.team_id
       LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = u.id AND tm.status = 'active'
      WHERE u.id = $2 AND u.status = 'active'`,
    [documentId, actorId],
  );
  const row = result.rows[0];
  if (!row || (row.role !== "teacher" && !(row.active_member && row.leader_user_id === actorId))) {
    throw new Error("복원은 교사 또는 현재 팀장만 할 수 있습니다.");
  }
}

export async function restorePlanRevision(planId: string, revisionId: string, actorId: string) {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertRestorePermission(client, "plan", planId, actorId);
    const revision = await client.query<{ snapshot: PlanSnapshot | string }>(
      "SELECT snapshot FROM document_revisions WHERE id = $1 AND document_type = 'plan' AND document_id = $2",
      [revisionId, planId],
    );
    const row = revision.rows[0];
    if (!row) throw new Error("복원할 계획서 이력을 찾을 수 없습니다.");
    const snapshot = parseJson(row.snapshot, { formData: {}, reviewStatus: "draft", teacherFeedback: null });
    await recordPlanRevision(client, planId, actorId, "restore_previous_state");
    const current = await client.query<{ review_status: string }>("SELECT review_status FROM investigation_plans WHERE id = $1 FOR UPDATE", [planId]);
    const nextStatus = current.rows[0]?.review_status === "approved" ? "reapproval_required" : "draft";
    await client.query(
      `UPDATE investigation_plans
          SET form_data = $1, review_status = $2, teacher_feedback = NULL, reviewed_by = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $3`,
      [JSON.stringify(snapshot.formData), nextStatus, planId],
    );
    await client.query(
      `UPDATE inquiry_sessions SET selected_topic = $1, last_activity_at = CURRENT_TIMESTAMP
        WHERE id = (SELECT session_id FROM investigation_plans WHERE id = $2)`,
      [String(snapshot.formData.topic ?? "").trim() || null, planId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actorId, "plan_revision_restored", "investigation_plan", planId, { revisionId });
}

export async function restoreReportRevision(reportId: string, revisionId: string, actorId: string) {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertRestorePermission(client, "report", reportId, actorId);
    const revision = await client.query<{ snapshot: ReportSnapshot | string }>(
      "SELECT snapshot FROM document_revisions WHERE id = $1 AND document_type = 'report' AND document_id = $2",
      [revisionId, reportId],
    );
    const row = revision.rows[0];
    if (!row) throw new Error("복원할 보고서 이력을 찾을 수 없습니다.");
    const snapshot = parseJson(row.snapshot, { formData: {}, status: "draft", teacherFeedback: null, roles: [] });
    await recordReportRevision(client, reportId, actorId, "restore_previous_state");
    await client.query("DELETE FROM report_fields WHERE report_id = $1", [reportId]);
    await client.query("DELETE FROM report_member_roles WHERE report_id = $1", [reportId]);
    for (const role of snapshot.roles) {
      await client.query(
        "INSERT INTO report_member_roles (report_id, user_id, role_description) VALUES ($1, $2, $3)",
        [reportId, role.userId, role.description],
      );
    }
    await client.query(
      `UPDATE reports
          SET form_data = $1, status = 'draft', teacher_feedback = NULL, reviewed_by = NULL,
              submitted_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [JSON.stringify(snapshot.formData), reportId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actorId, "report_revision_restored", "report", reportId, { revisionId });
}
