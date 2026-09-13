import { audit, getDb } from "@/lib/db";
import { createHash } from "node:crypto";
import { FormWriteConflict, sameFormValue } from "@/lib/form-write-conflict";
import type { FormFieldDefinition } from "@/lib/club-settings";
import { assertClubSettingsAccess } from "@/lib/club-settings";
import { UserFacingError } from "@/lib/user-facing-error";
import { ACADEMIC_YEAR } from "@/lib/constants";
import type { PoolClient } from "pg";
import { lockStudentTeams } from "@/lib/team-mutation-locks";
import { createId } from "@/lib/id";

type Definition = {
  description?: string;
  responseMode?: "team" | "individual";
  workflow?: "save" | "review";
  useForExam?: boolean;
  fields?: FormFieldDefinition[];
};

function parseJson<T>(value: T | string | null, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function context(actorId: string, sessionId: string, configVersionId: string, connection?: Pick<PoolClient, "query">) {
  const db = connection ?? await getDb();
  const result = await db.query<{
    club_id: string; definition: Definition | string; title: string; member: number | string;
  }>(`SELECT t.club_id, v.definition, v.title,
            COUNT(tm.user_id) AS member
       FROM inquiry_sessions s
       JOIN teams t ON t.id = s.team_id
       JOIN clubs c ON c.id = t.club_id AND c.academic_year = $4
       JOIN users u ON u.id = $1 AND u.role = 'student' AND u.status = 'active'
         AND u.must_change_password = FALSE AND u.academic_year = $4
       JOIN club_config_versions v ON v.club_id = t.club_id
       LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1 AND tm.status = 'active'
      WHERE s.id = $2 AND t.status = 'active' AND v.id = $3 AND v.config_type = 'custom_tab' AND v.status = 'published'
      GROUP BY t.club_id, v.definition, v.title`, [actorId, sessionId, configVersionId, ACADEMIC_YEAR]);
  const row = result.rows[0];
  if (!row || Number(row.member) < 1) throw new UserFacingError("이 동아리 탭에 접근할 수 없습니다.");
  const definition = parseJson(row.definition, {});
  return { ...row, definition, responseStudentId: definition.responseMode === "individual" ? actorId : null };
}

function validateResponse(definition: Definition, value: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const field of definition.fields ?? []) {
    const raw = value[field.id];
    if (field.kind === "heading") continue;
    if (field.required && (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0))) throw new UserFacingError(`${field.label} 항목을 입력해 주세요.`);
    if (field.kind === "number") result[field.id] = raw === "" || raw == null ? "" : Number(raw);
    else if (field.kind === "multiple_choice") result[field.id] = Array.isArray(raw) ? raw.map(String).slice(0, 30) : [];
    else if (field.kind === "checkbox") result[field.id] = Boolean(raw);
    else if (field.kind === "table") result[field.id] = Array.isArray(raw) ? raw.slice(0, 100) : [];
    else result[field.id] = String(raw ?? "").slice(0, 20_000);
  }
  return result;
}

export async function getCustomTabResponse(actorId: string, sessionId: string, configVersionId: string) {
  const info = await context(actorId, sessionId, configVersionId);
  const db = await getDb();
  const ownerClause = info.responseStudentId ? "student_id = $3" : "student_id IS NULL";
  const params = info.responseStudentId ? [configVersionId, sessionId, info.responseStudentId] : [configVersionId, sessionId];
  const result = await db.query<{ response_data: Record<string, unknown> | string; status: string; teacher_feedback: string | null; write_version: number }>(
    `SELECT response_data, status, teacher_feedback, write_version FROM club_custom_responses
      WHERE config_version_id = $1 AND session_id = $2 AND ${ownerClause}
      ORDER BY updated_at DESC LIMIT 2`, params,
  );
  const response = result.rows[0];
  if (result.rows.length > 1) throw new FormWriteConflict("이 탭에 중복된 과거 기록이 있습니다. 기록을 보존하고 있으니 선생님에게 확인을 요청해 주세요.");
  return {
    title: info.title,
    definition: info.definition,
    responseData: parseJson(response?.response_data ?? null, {}),
    status: response?.status ?? "draft",
    teacherFeedback: response?.teacher_feedback ?? null,
    version: response?.write_version ?? null,
  };
}

export async function saveCustomTabResponse(actorId: string, input: { sessionId: string; configVersionId: string; responseData: Record<string, unknown>; submit: boolean; expectedVersion?: number | null }) {
  const client = await (await getDb()).connect();
  try {
  await client.query("BEGIN");
  const target = (await client.query<{ team_id: string }>("SELECT team_id FROM inquiry_sessions WHERE id=$1 FOR UPDATE", [input.sessionId])).rows[0];
  if (!target) throw new UserFacingError("이 동아리 탭에 접근할 수 없습니다.");
  await lockStudentTeams(client, actorId, [target.team_id]);
  const info = await context(actorId, input.sessionId, input.configVersionId, client);
  const responseData = validateResponse(info.definition, input.responseData);
  const nextStatus = input.submit && info.definition.workflow === "review" ? "submitted" : "draft";
  const db = client;
  const ownerClause = info.responseStudentId ? "student_id = $3" : "student_id IS NULL";
  const params = info.responseStudentId ? [input.configVersionId, input.sessionId, info.responseStudentId] : [input.configVersionId, input.sessionId];
  const existing = await db.query<{ id: string; write_version: number; response_data: Record<string, unknown> | string; status: string }>(`SELECT id, write_version, response_data, status FROM club_custom_responses WHERE config_version_id = $1 AND session_id = $2 AND ${ownerClause} ORDER BY updated_at DESC LIMIT 2`, params);
  if (existing.rows.length > 1) throw new FormWriteConflict("중복된 과거 기록이 있어 저장을 중단했습니다. 선생님에게 확인을 요청해 주세요.");
  const row = existing.rows[0];
  // Stable identity also covers NULL student_id team responses, which the legacy
  // nullable unique constraint cannot protect against simultaneous first inserts.
  const id = row?.id ?? `club_response_${createHash("sha256").update(JSON.stringify(params)).digest("hex")}`;
  let version: number;
  if (row) {
    if (sameFormValue(parseJson(row.response_data, {}), responseData) && row.status === nextStatus) {
      await client.query("COMMIT");
      return { version: row.write_version };
    }
    if (input.expectedVersion !== row.write_version) throw new FormWriteConflict();
    const saved = await db.query<{ write_version: number }>(`UPDATE club_custom_responses SET response_data = $1, status = $2, submitted_by = $3,
      submitted_at = CASE WHEN $4 = TRUE THEN CURRENT_TIMESTAMP::timestamptz ELSE submitted_at END,
      teacher_feedback = CASE WHEN $4 = TRUE THEN NULL ELSE teacher_feedback END,
      reviewed_by = CASE WHEN $4 = TRUE THEN NULL ELSE reviewed_by END, updated_at = CURRENT_TIMESTAMP,
      write_version = write_version + 1 WHERE id = $5 AND write_version = $6 RETURNING write_version`,
    [JSON.stringify(responseData), nextStatus, actorId, input.submit, id, input.expectedVersion]);
    if (!saved.rows[0]) throw new FormWriteConflict();
    version = saved.rows[0].write_version;
  } else {
    if (input.expectedVersion != null) throw new FormWriteConflict();
    const saved = await db.query<{ write_version: number }>(`INSERT INTO club_custom_responses (id, config_version_id, session_id, student_id, response_data, status, submitted_by, submitted_at, write_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 = TRUE THEN CURRENT_TIMESTAMP ELSE NULL END, 1)
      ON CONFLICT DO NOTHING RETURNING write_version`,
    [id, input.configVersionId, input.sessionId, info.responseStudentId, JSON.stringify(responseData), nextStatus, actorId, input.submit]);
    if (!saved.rows[0]) throw new FormWriteConflict();
    version = saved.rows[0].write_version;
  }
  await client.query("INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,detail) VALUES($1,$2,$3,'club_custom_response',$4,$5)",
    [createId("audit"), actorId, input.submit ? "club_custom_tab_submitted" : "club_custom_tab_saved", id, JSON.stringify({ configVersionId: input.configVersionId })]);
  await client.query("COMMIT");
  return { version };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reviewCustomTabResponse(actorId: string, input: { responseId: string; teacherFeedback: string; reviewed: boolean; expectedVersion?: number }) {
  const feedback = input.teacherFeedback.trim();
  if (feedback.length > 2_000) throw new UserFacingError("교사 피드백은 2,000자 이내로 입력해 주세요.");
  const db = await getDb();
  const result = await db.query<{ club_id: string; status: string; write_version: number }>(
    `SELECT v.club_id, r.status, r.write_version FROM club_custom_responses r
       JOIN club_config_versions v ON v.id = r.config_version_id WHERE r.id = $1`,
    [input.responseId],
  );
  const row = result.rows[0];
  if (!row) throw new UserFacingError("검토할 제출물을 찾을 수 없습니다.");
  await assertClubSettingsAccess(actorId, row.club_id);
  if (!['submitted', 'feedback', 'reviewed'].includes(row.status)) throw new UserFacingError("학생이 제출한 뒤 검토할 수 있습니다.");
  if (input.reviewed && !feedback) throw new UserFacingError("검토 완료 전에 학생에게 보낼 피드백을 입력해 주세요.");
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.write_version) throw new FormWriteConflict();
  const saved = await db.query(
    `UPDATE club_custom_responses SET status = $1, teacher_feedback = $2, reviewed_by = $3,
       updated_at = CURRENT_TIMESTAMP, write_version = write_version + 1 WHERE id = $4 AND write_version = $5 RETURNING id`,
    [input.reviewed ? "reviewed" : "feedback", feedback, actorId, input.responseId, row.write_version],
  );
  if (!saved.rows[0]) throw new FormWriteConflict();
  await audit(actorId, input.reviewed ? "club_custom_tab_reviewed" : "club_custom_tab_feedback_saved", "club_custom_response", input.responseId);
}
