import type { PoolClient } from "pg";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { lockDocumentCycle } from "@/lib/document-cycle";
import { lockStudentsTeams } from "@/lib/team-mutation-locks";
import { UserFacingError } from "@/lib/user-facing-error";

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
  configDefinition?: Record<string, unknown>;
};

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export async function recordPlanRevision(db: Queryable, planId: string, actorId: string, action: string, previous?: PlanSnapshot) {
  const result = await db.query<{
    form_data: Record<string, unknown> | string;
    review_status: string;
    teacher_feedback: string | null;
    cycle_id: string | null;
  }>("SELECT form_data, review_status, teacher_feedback, cycle_id FROM investigation_plans WHERE id = $1", [planId]);
  const row = result.rows[0];
  if (!row) throw new UserFacingError("계획서를 찾을 수 없습니다.");
  const snapshot: PlanSnapshot = previous ?? {
    formData: parseJson(row.form_data, {}),
    reviewStatus: row.review_status,
    teacherFeedback: row.teacher_feedback,
  };
  await db.query(
    `INSERT INTO document_revisions (id, document_type, document_id, cycle_id, snapshot, action, changed_by)
     VALUES ($1, 'plan', $2, $3, $4, $5, $6)`,
    [createId("revision"), planId, row.cycle_id, JSON.stringify(snapshot), action, actorId],
  );
}

export async function recordReportRevision(db: Queryable, reportId: string, actorId: string, action: string) {
  const result = await db.query<{
    form_data: Record<string, unknown> | string;
    status: string;
    teacher_feedback: string | null;
    cycle_id: string | null;
    config_version_id: string | null;
  }>("SELECT form_data, status, teacher_feedback, cycle_id, config_version_id FROM reports WHERE id = $1", [reportId]);
  const row = result.rows[0];
  if (!row) throw new UserFacingError("보고서를 찾을 수 없습니다.");
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
  const config = row.config_version_id
    ? await db.query<{ definition: Record<string, unknown> | string }>("SELECT definition FROM club_config_versions WHERE id = $1", [row.config_version_id])
    : { rows: [] };
  const snapshot: ReportSnapshot = {
    formData,
    status: row.status,
    teacherFeedback: row.teacher_feedback,
    roles: roles.rows.map((role) => ({ userId: role.user_id, description: role.role_description })),
    configDefinition: parseJson(config.rows[0]?.definition ?? {}, {}),
  };
  await db.query(
    `INSERT INTO document_revisions (id, document_type, document_id, cycle_id, snapshot, action, changed_by)
     VALUES ($1, 'report', $2, $3, $4, $5, $6)`,
    [createId("revision"), reportId, row.cycle_id, JSON.stringify(snapshot), action, actorId],
  );
}

export async function getDocumentHistory(documentType: DocumentType, documentId: string, cycleId?: string | null) {
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
        AND dr.cycle_id = COALESCE($3, (
          SELECT cycle_id FROM ${documentType === "plan" ? "investigation_plans" : "reports"} WHERE id = $2
        ))
      ORDER BY dr.created_at DESC, dr.id DESC LIMIT 30`,
    [documentType, documentId, cycleId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorName: row.actor_name,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

async function assertRestorePermission(db: PoolClient, documentType: DocumentType, documentId: string, actorId: string, restoredRoleIds: string[] = []) {
  const table = documentType === "plan" ? "investigation_plans" : "reports";
  const target = (await db.query<{ team_id: string }>(
    `SELECT s.team_id FROM ${table} d JOIN inquiry_sessions s ON s.id = d.session_id WHERE d.id = $1`, [documentId],
  )).rows[0];
  if (!target) throw new UserFacingError("복원할 문서를 찾을 수 없습니다.");
  // Restored report roles reference historical users. Lock those users before
  // teams too, so foreign-key checks cannot invert membership writers' order.
  await lockStudentsTeams(db, [actorId, ...restoredRoleIds], [target.team_id]);
  const result = await db.query<{ role: string; leader_user_id: string | null; team_status: string; active_member: boolean }>(
    `SELECT u.role, t.leader_user_id, t.status AS team_status, (tm.user_id IS NOT NULL) AS active_member
       FROM users u
       JOIN ${table} d ON d.id = $1
       JOIN inquiry_sessions s ON s.id = d.session_id
       JOIN teams t ON t.id = s.team_id
       LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = u.id AND tm.status = 'active'
      WHERE u.id = $2 AND u.status = 'active' AND u.must_change_password = FALSE`,
    [documentId, actorId],
  );
  const row = result.rows[0];
  if (!row || (row.role !== "teacher" && !(row.team_status === "active" && row.active_member && row.leader_user_id === actorId))) {
    throw new UserFacingError("복원은 교사 또는 현재 팀장만 할 수 있습니다.");
  }
}

export async function restorePlanRevision(planId: string, revisionId: string, actorId: string, expectedCycleId?: string) {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockDocumentCycle(client, "plan", planId, expectedCycleId);
    await assertRestorePermission(client, "plan", planId, actorId);
    const revision = await client.query<{ snapshot: PlanSnapshot | string }>(
      `SELECT dr.snapshot FROM document_revisions dr
        JOIN investigation_plans p ON p.id = dr.document_id AND p.cycle_id = dr.cycle_id
       WHERE dr.id = $1 AND dr.document_type = 'plan' AND dr.document_id = $2`,
      [revisionId, planId],
    );
    const row = revision.rows[0];
    if (!row) throw new UserFacingError("복원할 계획서 이력을 찾을 수 없습니다.");
    const snapshot = parseJson(row.snapshot, { formData: {}, reviewStatus: "draft", teacherFeedback: null });
    await recordPlanRevision(client, planId, actorId, "restore_previous_state");
    const current = await client.query<{ review_status: string }>("SELECT review_status FROM investigation_plans WHERE id = $1 FOR UPDATE", [planId]);
    const nextStatus = current.rows[0]?.review_status === "approved" ? "reapproval_required" : "draft";
    if (current.rows[0]?.review_status === "pending") {
      await client.query(
        "UPDATE plan_submissions SET review_status = 'withdrawn' WHERE plan_id = $1 AND review_status = 'pending'",
        [planId],
      );
    }
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

export async function restoreReportRevision(reportId: string, revisionId: string, actorId: string, expectedCycleId?: string) {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockDocumentCycle(client, "report", reportId, expectedCycleId);
    const revision = await client.query<{ snapshot: ReportSnapshot | string }>(
      `SELECT dr.snapshot FROM document_revisions dr
        JOIN reports r ON r.id = dr.document_id AND r.cycle_id = dr.cycle_id
       WHERE dr.id = $1 AND dr.document_type = 'report' AND dr.document_id = $2`,
      [revisionId, reportId],
    );
    const row = revision.rows[0];
    if (!row) throw new UserFacingError("복원할 보고서 이력을 찾을 수 없습니다.");
    const snapshot = parseJson(row.snapshot, { formData: {}, status: "draft", teacherFeedback: null, roles: [] });
    await assertRestorePermission(client, "report", reportId, actorId, snapshot.roles.map(role => role.userId));
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
              submitted_at = NULL, updated_at = CURRENT_TIMESTAMP, write_version = write_version + 1
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
