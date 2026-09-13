import { audit, getDb } from "@/lib/db";
import { sameFieldValue } from "@/lib/document-drafts";
import { recordPlanRevision } from "@/lib/document-history";
import { createActionNotice, resolveActionNotices } from "@/lib/notices";
import { sendPushForNotice } from "@/lib/push-notifications";
import { createPlanSubmission, getLatestPlanSubmission } from "@/lib/plan-snapshots";
import { lockDocumentCycle, withDocumentCycle } from "@/lib/document-cycle";
import { lockTeacherReviewAccess } from "@/lib/teacher-review-access";
import { UserFacingError } from "@/lib/user-facing-error";

const ALLOWED_FIELDS = new Set([
  "field", "topic", "motivation", "purpose", "theory", "priorResearch", "method",
  "differentiation", "schedule", "expectedResult", "references",
]);

function parseDefinition(value: Record<string, unknown> | string | null) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

async function planFields(planId: string) {
  const db = await getDb();
  const result = await db.query<{ config_version_id: string | null; definition: Record<string, unknown> | string | null }>(`SELECT p.config_version_id, v.definition
    FROM investigation_plans p JOIN inquiry_cycles c ON c.id = p.cycle_id AND c.status = 'active'
    LEFT JOIN club_config_versions v ON v.id = p.config_version_id WHERE p.id = $1`, [planId]);
  const row = result.rows[0];
  if (!row) throw new UserFacingError("계획서를 찾을 수 없습니다.");
  const definition = parseDefinition(row.definition);
  const fields = Array.isArray(definition?.fields) ? definition.fields as Array<{ id?: unknown; required?: unknown; kind?: unknown }> : [];
  return row.config_version_id ? fields.filter((field) => typeof field.id === "string" && field.kind !== "heading") : [...ALLOWED_FIELDS].map((id) => ({ id, required: ["field", "topic", "motivation", "purpose", "method", "expectedResult"].includes(id) }));
}

async function assertPlanField(planId: string, fieldKey: string) {
  if (!(await planFields(planId)).some((field) => field.id === fieldKey)) throw new UserFacingError("계획서 항목을 확인해 주세요.");
}

export async function lockPlanField(planId: string, fieldKey: string, user: { id: string; name: string }, expectedCycleId?: string) {
  await assertPlanField(planId, fieldKey);
  return withDocumentCycle("plan", planId, expectedCycleId, async (db) => {
  const now = new Date();
  await db.query("DELETE FROM field_locks WHERE expires_at <= $1", [now]);
  const current = await db.query<{ user_id: string; user_name: string }>(
    "SELECT user_id, user_name FROM field_locks WHERE plan_id = $1 AND field_key = $2",
    [planId, fieldKey],
  );
  if (current.rows[0] && current.rows[0].user_id !== user.id) {
    throw new UserFacingError(`${current.rows[0].user_name} 학생이 작성 중입니다.`);
  }
  const acquired = await db.query<{ user_id: string }>(
    `INSERT INTO field_locks (plan_id, field_key, user_id, user_name, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (plan_id, field_key) DO UPDATE
       SET user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, expires_at = EXCLUDED.expires_at
       WHERE field_locks.user_id = EXCLUDED.user_id OR field_locks.expires_at <= $6
       RETURNING user_id`,
    [planId, fieldKey, user.id, user.name, new Date(now.getTime() + 35_000), now],
  );
  if (acquired.rows[0]?.user_id !== user.id) throw new UserFacingError("다른 팀원이 이 항목을 작성 중입니다.");
  });
}

export async function releasePlanField(planId: string, fieldKey: string, userId: string, expectedCycleId?: string) {
  return withDocumentCycle("plan", planId, expectedCycleId, async (db) => {
  await db.query("DELETE FROM field_locks WHERE plan_id = $1 AND field_key = $2 AND user_id = $3", [planId, fieldKey, userId]);
  });
}

export async function savePlanField(planId: string, fieldKey: string, value: unknown, userId: string, expectedValue?: unknown, expectedCycleId?: string) {
  await assertPlanField(planId, fieldKey);
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockDocumentCycle(client, "plan", planId, expectedCycleId);
    let saved = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await client.query<{ form_data: Record<string, unknown> | string; review_status: string; teacher_feedback: string | null }>(
        `SELECT p.form_data, p.review_status, p.teacher_feedback FROM investigation_plans p
          JOIN inquiry_cycles c ON c.id = p.cycle_id AND c.status = 'active' WHERE p.id = $1`, [planId],
      );
      const current = result.rows[0];
      if (!current) throw new UserFacingError("계획서를 찾을 수 없습니다.");
      const lock = await client.query<{ user_id: string; user_name: string }>(
        "SELECT user_id, user_name FROM field_locks WHERE plan_id = $1 AND field_key = $2 AND expires_at > $3",
        [planId, fieldKey, new Date()],
      );
      if (lock.rows[0] && lock.rows[0].user_id !== userId) throw new UserFacingError(`${lock.rows[0].user_name} 학생이 작성 중입니다.`);
      const formData = typeof current.form_data === "string" ? JSON.parse(current.form_data) as Record<string, unknown> : current.form_data;
      if (sameFieldValue(formData[fieldKey], value)) { await client.query("COMMIT"); return; }
      if (expectedValue !== undefined && !sameFieldValue(formData[fieldKey], expectedValue)) {
        throw new UserFacingError("다른 곳에서 이 항목을 수정했습니다. 내 작성 내용을 복사해 둔 뒤 최신 내용과 비교해 주세요.");
      }
      // Compare and swap the complete JSON: retry a different-field save using
      // the newest document instead of overwriting a teammate's changes.
      const nextReviewStatus = current.review_status === "approved"
        ? "reapproval_required"
        : current.review_status === "pending" ? "draft" : current.review_status;
      const changed = await client.query(
        `UPDATE investigation_plans
            SET form_data = $1, review_status = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3 AND form_data = $4::jsonb AND review_status = $5`,
        [JSON.stringify({ ...formData, [fieldKey]: value }), nextReviewStatus,
          planId, JSON.stringify(current.form_data), current.review_status],
      );
      if (changed.rowCount !== 1) continue;
      await recordPlanRevision(client, planId, userId, `field:${fieldKey}`, {
        formData, reviewStatus: current.review_status, teacherFeedback: current.teacher_feedback,
      });
      if (current.review_status === "pending") {
        await client.query(
          "UPDATE plan_submissions SET review_status = 'withdrawn' WHERE plan_id = $1 AND review_status = 'pending'",
          [planId],
        );
      }
      if (fieldKey === "topic" && typeof value === "string") {
        await client.query(
          `UPDATE inquiry_sessions SET selected_topic = $1, last_activity_at = CURRENT_TIMESTAMP
            WHERE id = (SELECT session_id FROM investigation_plans WHERE id = $2)`,
          [value.trim() || null, planId],
        );
      }
      await client.query("COMMIT");
      saved = true;
      break;
    }
    if (!saved) throw new UserFacingError("다른 항목이 저장 중입니다. 잠시 후 다시 저장해 주세요.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  await audit(userId, "plan_field_saved", "investigation_plan", planId, { fieldKey });
}

export async function selectTopic(sessionId: string, planId: string, topic: string, actorId: string, expectedTopic?: string, expectedCycleId?: string) {
  const db = await getDb();
  const plan = await db.query<{ form_data: Record<string, unknown> | string; cycle_id: string }>(
    `SELECT p.form_data, p.cycle_id FROM investigation_plans p JOIN inquiry_cycles c ON c.id = p.cycle_id AND c.status = 'active'
      WHERE p.id = $1 AND p.session_id = $2`, [planId, sessionId],
  );
  if (!plan.rows[0]) throw new UserFacingError("계획서를 찾을 수 없습니다.");
  const form = typeof plan.rows[0].form_data === "string" ? JSON.parse(plan.rows[0].form_data) : plan.rows[0].form_data;
  // Reuse field locks, conflict detection, revision capture and reapproval.
  // The plan topic and session topic are written in that same transaction.
  await savePlanField(planId, "topic", topic, actorId, expectedTopic ?? form.topic ?? "", expectedCycleId ?? plan.rows[0].cycle_id);
  await db.query(
    "UPDATE inquiry_sessions SET stage = 'EXPLORING' WHERE id = $1 AND stage = 'STARTING' AND EXISTS (SELECT 1 FROM investigation_plans WHERE session_id = $1 AND cycle_id = $2)", [sessionId, plan.rows[0].cycle_id],
  );
  await audit(actorId, "topic_selected", "inquiry_session", sessionId);
}

export async function submitPlan(planId: string, userId: string, expectedCycleId?: string) {
  const db = await getDb();
  const required = (await planFields(planId)).filter((field) => Boolean(field.required)).map((field) => String(field.id));
  const client = await db.connect();
  let submissionNumber = 0;
  try {
    await client.query("BEGIN");
    await lockDocumentCycle(client, "plan", planId, expectedCycleId);
    const result = await client.query<{ form_data: Record<string, unknown> | string }>(
      `SELECT p.form_data FROM investigation_plans p JOIN inquiry_cycles c ON c.id = p.cycle_id AND c.status = 'active'
        WHERE p.id = $1 FOR UPDATE`, [planId],
    );
    if (!result.rows[0]) throw new UserFacingError("계획서를 찾을 수 없습니다.");
    const formData = typeof result.rows[0].form_data === "string" ? JSON.parse(result.rows[0].form_data) : result.rows[0].form_data;
    const missing = required.filter((key) => {
      const value = formData[key];
      return value == null || value === "" || (Array.isArray(value) && value.length === 0);
    });
    if (missing.length) throw new UserFacingError("필수 항목을 더 작성해 주세요.");
    submissionNumber = (await createPlanSubmission(client, planId, userId)).submissionNumber;
    await recordPlanRevision(client, planId, userId, "submit");
    await client.query(
      "UPDATE investigation_plans SET review_status = 'pending', teacher_feedback = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [planId],
    );
    await client.query(
      `UPDATE inquiry_sessions SET stage = 'PLANNING', last_activity_at = CURRENT_TIMESTAMP
        WHERE id = (SELECT session_id FROM investigation_plans WHERE id = $1)
          AND stage IN ('STARTING', 'EXPLORING', 'PLANNING')`,
      [planId],
    );
    await resolveActionNotices(client, "plan", planId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(userId, "plan_submitted", "investigation_plan", planId, { submissionNumber });
}

export async function reviewPlan(
  planId: string,
  teacherId: string,
  decision: "approved" | "feedback",
  feedback: string,
  confirmation = "",
  expected?: { submissionId: string | null; cycleId: string | null; status: string; feedback: string },
) {
  const db = await getDb();
  if (decision === "feedback" && !feedback.trim()) throw new UserFacingError("수정할 내용을 입력해 주세요.");
  const client = await db.connect();
  let previousStatus = "";
  let actionNoticeId: string | null = null;
  try {
    await client.query("BEGIN");
    await lockDocumentCycle(client, "plan", planId, expected?.cycleId ?? undefined);
    await lockTeacherReviewAccess(client, "plan", planId, teacherId);
    const current = await client.query<{ review_status: string; cycle_id: string; class_number: number; club_id: string | null; club_name: string | null; team_name: string; team_id: string }>(
      `SELECT p.review_status, p.cycle_id, c.class_number, t.club_id, cl.name AS club_name, t.name AS team_name, t.id AS team_id
         FROM investigation_plans p
         JOIN inquiry_cycles ic ON ic.id = p.cycle_id AND ic.status = 'active'
         JOIN inquiry_sessions s ON s.id = p.session_id
         JOIN teams t ON t.id = s.team_id
         LEFT JOIN classes c ON c.id = t.class_id
         LEFT JOIN clubs cl ON cl.id = t.club_id
        WHERE p.id = $1 AND t.status = 'active'`,
      [planId],
    );
    const plan = current.rows[0];
    if (!plan) throw new UserFacingError("계획서를 찾을 수 없습니다.");
    previousStatus = plan.review_status;

    if (plan.review_status !== "pending" && plan.review_status !== "approved" && plan.review_status !== "feedback") {
      throw new UserFacingError("학생이 제출한 최신 계획서만 검토할 수 있습니다.");
    }
    if (plan.review_status === "feedback" && decision === "approved") {
      throw new UserFacingError("수정 요청한 계획서는 학생이 다시 제출한 뒤 승인해 주세요.");
    }

    let submission = await getLatestPlanSubmission(client, planId, plan.cycle_id);
    if (expected) {
      const saved = await client.query<{ teacher_feedback: string | null }>("SELECT teacher_feedback FROM investigation_plans WHERE id = $1", [planId]);
      if (expected.submissionId !== (submission?.id ?? null) || expected.cycleId !== plan.cycle_id
          || expected.status !== plan.review_status || expected.feedback !== (saved.rows[0]?.teacher_feedback ?? "")) {
        throw new UserFacingError("제출본이나 검토 상태가 변경되었습니다. 작성한 피드백을 보관하고 최신 제출본을 다시 확인해 주세요.");
      }
    }

    if (plan.review_status === "approved") {
      if (decision === "approved") throw new UserFacingError("이미 승인된 계획서입니다.");
      const expectedConfirmation = `${plan.club_name ?? `${plan.class_number}반`} ${plan.team_name}`;
      if (confirmation.trim() !== expectedConfirmation) {
        throw new UserFacingError(`승인 상태를 변경하려면 '${expectedConfirmation}'을(를) 정확히 입력해 주세요.`);
      }
    }

    await recordPlanRevision(client, planId, teacherId, decision === "approved" ? "teacher_approve" : "teacher_feedback");
    const updated = await client.query(
      `UPDATE investigation_plans
          SET review_status = $1, teacher_feedback = $2, reviewed_by = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $4 AND review_status = $5`,
      [decision, feedback.trim() || null, teacherId, planId, plan.review_status],
    );
    if (updated.rowCount !== 1) throw new UserFacingError("계획서 상태가 방금 변경되었습니다. 화면을 새로고침한 뒤 다시 확인해 주세요.");
    if (!submission) {
      await createPlanSubmission(client, planId, teacherId, "legacy_capture");
      submission = await getLatestPlanSubmission(client, planId, plan.cycle_id);
    }
    if (!submission) throw new UserFacingError("검토할 계획서 저장본을 고정하지 못했습니다.");
    await client.query(
      `UPDATE plan_submissions
          SET review_status = $2, teacher_feedback = $3, reviewed_by = $4, reviewed_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [submission.id, decision, feedback.trim() || null, teacherId],
    );
    if (decision === "feedback") {
      actionNoticeId = await createActionNotice(client, { teacherId, teamId: plan.team_id, sourceType: "plan", sourceId: planId, content: feedback });
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
  if (actionNoticeId) await sendPushForNotice(actionNoticeId);
}
