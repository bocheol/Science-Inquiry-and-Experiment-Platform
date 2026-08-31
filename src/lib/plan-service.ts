import { audit, getDb } from "@/lib/db";
import { recordPlanRevision } from "@/lib/document-history";
import { createActionNotice, resolveActionNotices } from "@/lib/notices";

const ALLOWED_FIELDS = new Set([
  "field", "topic", "motivation", "purpose", "theory", "priorResearch", "method",
  "differentiation", "schedule", "expectedResult", "references",
]);

export async function lockPlanField(planId: string, fieldKey: string, user: { id: string; name: string }) {
  if (!ALLOWED_FIELDS.has(fieldKey)) throw new Error("계획서 항목을 확인해 주세요.");
  const db = await getDb();
  const now = new Date();
  await db.query("DELETE FROM field_locks WHERE expires_at <= $1", [now]);
  const current = await db.query<{ user_id: string; user_name: string }>(
    "SELECT user_id, user_name FROM field_locks WHERE plan_id = $1 AND field_key = $2",
    [planId, fieldKey],
  );
  if (current.rows[0] && current.rows[0].user_id !== user.id) {
    throw new Error(`${current.rows[0].user_name} 학생이 작성 중입니다.`);
  }
  await db.query(
    `INSERT INTO field_locks (plan_id, field_key, user_id, user_name, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (plan_id, field_key) DO UPDATE
       SET user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, expires_at = EXCLUDED.expires_at`,
    [planId, fieldKey, user.id, user.name, new Date(now.getTime() + 35_000)],
  );
}

export async function releasePlanField(planId: string, fieldKey: string, userId: string) {
  const db = await getDb();
  await db.query("DELETE FROM field_locks WHERE plan_id = $1 AND field_key = $2 AND user_id = $3", [planId, fieldKey, userId]);
}

export async function savePlanField(planId: string, fieldKey: string, value: unknown, userId: string) {
  if (!ALLOWED_FIELDS.has(fieldKey)) throw new Error("계획서 항목을 확인해 주세요.");
  const db = await getDb();
  const current = await db.query<{ form_data: Record<string, unknown> | string; review_status: string }>(
    "SELECT form_data, review_status FROM investigation_plans WHERE id = $1",
    [planId],
  );
  if (!current.rows[0]) throw new Error("계획서를 찾을 수 없습니다.");
  const lock = await db.query<{ user_id: string; user_name: string }>(
    "SELECT user_id, user_name FROM field_locks WHERE plan_id = $1 AND field_key = $2 AND expires_at > $3",
    [planId, fieldKey, new Date()],
  );
  if (lock.rows[0] && lock.rows[0].user_id !== userId) throw new Error(`${lock.rows[0].user_name} 학생이 작성 중입니다.`);
  const formData = typeof current.rows[0].form_data === "string" ? JSON.parse(current.rows[0].form_data) : current.rows[0].form_data;
  if (JSON.stringify(formData[fieldKey] ?? null) === JSON.stringify(value ?? null)) return;
  await recordPlanRevision(db, planId, userId, `field:${fieldKey}`);
  formData[fieldKey] = value;
  const nextStatus = current.rows[0].review_status === "approved" ? "reapproval_required" : current.rows[0].review_status;
  await db.query(
    `UPDATE investigation_plans SET form_data = $1, review_status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [JSON.stringify(formData), nextStatus, planId],
  );
  if (fieldKey === "topic" && typeof value === "string") {
    await db.query(
      `UPDATE inquiry_sessions SET selected_topic = $1, last_activity_at = CURRENT_TIMESTAMP
        WHERE id = (SELECT session_id FROM investigation_plans WHERE id = $2)`,
      [value.trim() || null, planId],
    );
  }
  await audit(userId, "plan_field_saved", "investigation_plan", planId, { fieldKey });
}

export async function submitPlan(planId: string, userId: string) {
  const db = await getDb();
  const result = await db.query<{ form_data: Record<string, unknown> | string }>("SELECT form_data FROM investigation_plans WHERE id = $1", [planId]);
  if (!result.rows[0]) throw new Error("계획서를 찾을 수 없습니다.");
  const formData = typeof result.rows[0].form_data === "string" ? JSON.parse(result.rows[0].form_data) : result.rows[0].form_data;
  const required = ["field", "topic", "motivation", "purpose", "method", "expectedResult"];
  const missing = required.filter((key) => !String(formData[key] ?? "").trim());
  if (missing.length) throw new Error("필수 항목을 더 작성해 주세요.");
  await recordPlanRevision(db, planId, userId, "submit");
  await db.query(
    "UPDATE investigation_plans SET review_status = 'pending', teacher_feedback = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
    [planId],
  );
  await db.query(
    `UPDATE inquiry_sessions SET stage = 'PLANNING', last_activity_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT session_id FROM investigation_plans WHERE id = $1)
        AND stage IN ('STARTING', 'EXPLORING', 'PLANNING')`,
    [planId],
  );
  await resolveActionNotices(db, "plan", planId);
  await audit(userId, "plan_submitted", "investigation_plan", planId);
}

export async function reviewPlan(
  planId: string,
  teacherId: string,
  decision: "approved" | "feedback",
  feedback: string,
  confirmation = "",
) {
  const db = await getDb();
  if (decision === "feedback" && !feedback.trim()) throw new Error("수정할 내용을 입력해 주세요.");
  const client = await db.connect();
  let previousStatus = "";
  try {
    await client.query("BEGIN");
    const current = await client.query<{ review_status: string; class_number: number; team_name: string; team_id: string }>(
      `SELECT p.review_status, c.class_number, t.name AS team_name, t.id AS team_id
         FROM investigation_plans p
         JOIN inquiry_sessions s ON s.id = p.session_id
         JOIN teams t ON t.id = s.team_id
         JOIN classes c ON c.id = t.class_id
        WHERE p.id = $1`,
      [planId],
    );
    const plan = current.rows[0];
    if (!plan) throw new Error("계획서를 찾을 수 없습니다.");
    previousStatus = plan.review_status;

    if (plan.review_status === "approved") {
      if (decision === "approved") throw new Error("이미 승인된 계획서입니다.");
      const expectedConfirmation = `${plan.class_number}반 ${plan.team_name}`;
      if (confirmation.trim() !== expectedConfirmation) {
        throw new Error(`승인 상태를 변경하려면 '${expectedConfirmation}'을(를) 정확히 입력해 주세요.`);
      }
    }

    await recordPlanRevision(client, planId, teacherId, decision === "approved" ? "teacher_approve" : "teacher_feedback");
    const updated = await client.query(
      `UPDATE investigation_plans
          SET review_status = $1, teacher_feedback = $2, reviewed_by = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4 AND review_status = $5`,
      [decision, feedback.trim() || null, teacherId, planId, plan.review_status],
    );
    if (updated.rowCount !== 1) throw new Error("계획서 상태가 방금 변경되었습니다. 화면을 새로고침한 뒤 다시 확인해 주세요.");
    if (decision === "feedback") {
      await createActionNotice(client, { teacherId, teamId: plan.team_id, sourceType: "plan", sourceId: planId, content: feedback });
    } else {
      await resolveActionNotices(client, "plan", planId);
      await client.query(
        `UPDATE inquiry_sessions SET stage = 'EXPERIMENTING', last_activity_at = CURRENT_TIMESTAMP
          WHERE id = (SELECT session_id FROM investigation_plans WHERE id = $1)
            AND stage IN ('STARTING', 'EXPLORING', 'PLANNING')`,
        [planId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(teacherId, decision === "approved" ? "plan_approved" : "plan_feedback", "investigation_plan", planId, {
    previousStatus,
    protectedStatusChange: previousStatus === "approved",
  });
}
