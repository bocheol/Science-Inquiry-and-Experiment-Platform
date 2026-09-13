import type { PoolClient } from "pg";
import { audit, getDb } from "@/lib/db";
import { recordPlanRevision, recordReportRevision } from "@/lib/document-history";
import { buildCycleEvidencePayload, cycleEvidenceHash } from "@/lib/cycle-evidence";
import { isCurrentCycleAnalysisVersion } from "@/lib/cycle-analysis";
import { PRACTICE_MATERIAL_SQL } from "@/lib/material-practice";
import { lockTeacherCycleAccess } from "@/lib/teacher-cycle-access";
import { UserFacingError } from "@/lib/user-facing-error";

export type CycleTransitionAction = "start_next" | "finish_project";

async function teacherAccess(client: PoolClient, cycleId: string, teacherId: string) {
  const result = await client.query<{
    session_id: string; ordinal: number; status: string; team_id: string; club_id: string | null;
    is_master: boolean; assigned: number | string;
  }>(`SELECT c.session_id, c.ordinal, c.status, t.id AS team_id, t.club_id,
             u.is_master, COUNT(a.teacher_id) AS assigned
        FROM inquiry_cycles c
        JOIN inquiry_sessions s ON s.id = c.session_id
        JOIN teams t ON t.id = s.team_id
        JOIN users u ON u.id = $2 AND u.role = 'teacher' AND u.status = 'active'
        LEFT JOIN club_teacher_assignments a ON a.club_id = t.club_id AND a.teacher_id = u.id
       WHERE c.id = $1 AND t.status = 'active'
       GROUP BY c.session_id, c.ordinal, c.status, t.id, t.club_id, u.is_master`, [cycleId, teacherId]);
  const row = result.rows[0];
  if (!row || (row.club_id && !row.is_master && Number(row.assigned) === 0)) {
    throw new UserFacingError("이 탐구 회차를 관리할 권한이 없습니다.");
  }
  return row;
}

async function publishedDocumentVersions(client: PoolClient, clubId: string | null, currentPlan: string | null, currentReport: string | null) {
  if (!clubId) return { plan: null, report: null };
  const result = await client.query<{ id: string; config_type: "plan" | "report" }>(
    `SELECT id, config_type FROM club_config_versions
      WHERE club_id = $1 AND config_key = 'default' AND status = 'published'
        AND config_type IN ('plan', 'report')
      ORDER BY config_type, version_number DESC`, [clubId],
  );
  return {
    plan: result.rows.find((item) => item.config_type === "plan")?.id ?? currentPlan,
    report: result.rows.find((item) => item.config_type === "report")?.id ?? currentReport,
  };
}

export async function transitionCycle(input: {
  cycleId: string;
  action: CycleTransitionAction;
  teacherId: string;
}) {
  const db = await getDb();
  const client = await db.connect();
  let sessionId = "";
  let nextCycleId: string | null = null;
  try {
    await client.query("BEGIN");
    const access = await teacherAccess(client, input.cycleId, input.teacherId);
    sessionId = access.session_id;
    await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
    const lockedCycle = await client.query<{ status: string }>(
      "SELECT status FROM inquiry_cycles WHERE id = $1 FOR UPDATE", [input.cycleId],
    );
    if (lockedCycle.rows[0]?.status !== "active") throw new UserFacingError("현재 진행 중인 회차만 종료할 수 있습니다.");
    await lockTeacherCycleAccess(client, input.cycleId, input.teacherId);

    const requiredType = input.action === "start_next" ? "intermediate" : "final";
    if (input.action === "start_next" && (await client.query("SELECT id FROM cycle_ai_analyses WHERE cycle_id = $1 AND analysis_type = 'final' LIMIT 1", [input.cycleId])).rows.length) {
      throw new UserFacingError("최종 분석이 만들어진 회차입니다. 최신 최종 분석으로 탐구를 완료해 주세요.");
    }
    const analysisResult = await client.query<{
      id: string; content_hash: string; prompt_version: string; schema_version: string;
    }>(`SELECT a.id, s.content_hash, a.prompt_version, a.schema_version
          FROM cycle_ai_analyses a
          JOIN cycle_evidence_snapshots s ON s.id = a.snapshot_id
         WHERE a.cycle_id = $1 AND a.analysis_type = $2
         ORDER BY a.created_at DESC`, [input.cycleId, requiredType]);
    const analysis = analysisResult.rows[0];
    if (!analysis) {
      throw new UserFacingError(input.action === "start_next"
        ? "중간 AI 분석을 완료한 뒤 다음 회차를 시작할 수 있습니다."
        : "최종 AI 분석을 완료한 뒤 탐구를 마칠 수 있습니다.");
    }
    const currentHash = cycleEvidenceHash(await buildCycleEvidencePayload(client, input.cycleId, requiredType === "final"));
    if (!analysisResult.rows.some(item => item.content_hash === currentHash && isCurrentCycleAnalysisVersion(requiredType, item.prompt_version, item.schema_version))) {
      throw new UserFacingError("작성 자료나 AI 검토 기준이 바뀌었습니다. 최신 기준으로 다시 분석해 주세요.");
    }

    const documents = await client.query<{
      plan_id: string; report_id: string; plan_config_id: string | null; report_config_id: string | null;
      plan_status: string; report_status: string;
    }>(`SELECT p.id AS plan_id, r.id AS report_id, p.config_version_id AS plan_config_id,
               r.config_version_id AS report_config_id, p.review_status AS plan_status, r.status AS report_status
          FROM investigation_plans p
          JOIN reports r ON r.session_id = p.session_id
         WHERE p.session_id = $1 AND p.cycle_id = $2 AND r.cycle_id = $2`, [sessionId, input.cycleId]);
    const document = documents.rows[0];
    if (!document || document.plan_status !== "approved" || document.report_status !== "reviewed") {
      throw new UserFacingError("현재 회차의 승인된 계획서와 확인 완료 보고서를 다시 확인해 주세요.");
    }
    const unsynced = await client.query(
      `SELECT m.id FROM material_requests m LEFT JOIN users u ON u.id = m.submitted_by
        WHERE m.cycle_id = $1 AND m.sync_status <> 'synced' AND NOT ${PRACTICE_MATERIAL_SQL} LIMIT 1`, [input.cycleId],
    );
    if (unsynced.rows[0]) throw new UserFacingError("현재 회차의 준비물 신청 전송 상태를 먼저 확인해 주세요.");

    await client.query(
      `UPDATE inquiry_cycles SET status = 'completed', ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
              updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'active'`, [input.cycleId],
    );

    if (input.action === "finish_project") {
      await client.query(
        `UPDATE inquiry_sessions SET stage = 'COMPLETED', last_activity_at = CURRENT_TIMESTAMP WHERE id = $1`, [sessionId],
      );
    } else {
      const nextOrdinal = Number(access.ordinal) + 1;
      nextCycleId = `cycle_${sessionId}_${nextOrdinal}`;
      const configs = await publishedDocumentVersions(
        client, access.club_id, document.plan_config_id, document.report_config_id,
      );
      await recordPlanRevision(client, document.plan_id, input.teacherId, "cycle_completed");
      await recordReportRevision(client, document.report_id, input.teacherId, "cycle_completed");
      await client.query(
        `INSERT INTO inquiry_cycles
          (id, session_id, ordinal, title, status, origin, started_at, created_by)
         VALUES ($1,$2,$3,$4,'active','configured',CURRENT_TIMESTAMP,$5)`,
        [nextCycleId, sessionId, nextOrdinal, `${nextOrdinal}차 탐구`, input.teacherId],
      );
      await client.query("DELETE FROM field_locks WHERE plan_id = $1", [document.plan_id]);
      await client.query("DELETE FROM report_field_locks WHERE report_id = $1", [document.report_id]);
      await client.query("DELETE FROM report_fields WHERE report_id = $1", [document.report_id]);
      await client.query("DELETE FROM report_member_roles WHERE report_id = $1", [document.report_id]);
      await client.query(
        `UPDATE investigation_plans SET cycle_id = $1, config_version_id = $2, form_data = '{}',
                review_status = 'draft', teacher_feedback = NULL, reviewed_by = NULL,
                updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [nextCycleId, configs.plan, document.plan_id],
      );
      await client.query(
        `UPDATE reports SET cycle_id = $1, config_version_id = $2, form_data = '{}', status = 'draft',
                teacher_feedback = NULL, reviewed_by = NULL, submitted_at = NULL,
                updated_at = CURRENT_TIMESTAMP, write_version = write_version + 1 WHERE id = $3`,
        [nextCycleId, configs.report, document.report_id],
      );
      await client.query(
        `UPDATE inquiry_sessions SET stage = 'STARTING', selected_topic = NULL, interest_input = NULL,
                ai_topic_suggestions = '{}', last_activity_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [sessionId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await audit(input.teacherId, input.action === "start_next" ? "inquiry_cycle_next_started" : "inquiry_project_completed", "inquiry_cycle", input.cycleId, {
    nextCycleId,
  });
  return { sessionId, nextCycleId, completed: input.action === "finish_project" };
}
