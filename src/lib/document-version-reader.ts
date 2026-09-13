import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { defaultClubConfigDefinition, type FormFieldDefinition } from "@/lib/club-settings";
import type { SessionUser } from "@/lib/types";
import { UserFacingError } from "@/lib/user-facing-error";
import { versionActionLabel, type DocumentScope, type DocumentVersion, type VersionRef, type VersionList, type VersionOption } from "@/lib/document-version-types";

export class DocumentVersionError extends UserFacingError {
  constructor(message: string, public status: number) { super(message); }
}
type Queryable = Pick<PoolClient, "query">;
type Access = { session_id: string; team_id: string; team_name: string; club_id: string | null; cycle_title: string; cycle_status: string; current_cycle_id: string | null; config_version_id: string | null; session_version: number };
type Revision = { id: string; action: string; snapshot: unknown; created_at: Date | string; actor_name: string };
const unavailable = () => new DocumentVersionError("이 기록을 찾을 수 없거나 열람할 수 없습니다.", 404);

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function iso(value: Date | string | null) { return value == null ? null : new Date(value).toISOString(); }
function table(scope: DocumentScope) { return scope.documentType === "plan" ? "investigation_plans" : "reports"; }

async function access(db: Queryable, user: Pick<SessionUser, "id" | "role">, scope: DocumentScope): Promise<Access> {
  const actor = (await db.query<{ role: string; status: string; must_change_password: boolean; academic_year: number; session_version: number }>(
    "SELECT role, status, must_change_password, academic_year, session_version FROM users WHERE id = $1", [user.id],
  )).rows[0];
  if (!actor || actor.role !== user.role || actor.status !== "active" || actor.must_change_password || actor.academic_year !== ACADEMIC_YEAR) {
    throw new DocumentVersionError("권한이 없습니다. 다시 로그인해 주세요.", 403);
  }
  const row = (await db.query<Access & { team_status: string; academic_year: number }>(
    `SELECT d.session_id, d.cycle_id AS current_cycle_id, d.config_version_id,
            t.id AS team_id, t.name AS team_name, t.club_id, t.status AS team_status,
            c.title AS cycle_title, c.status AS cycle_status, COALESCE(cl.academic_year, cb.academic_year) AS academic_year
       FROM ${table(scope)} d JOIN inquiry_sessions s ON s.id = d.session_id
       JOIN teams t ON t.id = s.team_id JOIN inquiry_cycles c ON c.session_id = s.id AND c.id = $2
       LEFT JOIN classes cl ON cl.id = t.class_id LEFT JOIN clubs cb ON cb.id = t.club_id
      WHERE d.id = $1`, [scope.documentId, scope.cycleId],
  )).rows[0];
  if (!row) throw unavailable();
  if (user.role === "student") {
    if (row.team_status !== "active" || row.academic_year !== ACADEMIC_YEAR) throw unavailable();
    const member = (await db.query("SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2 AND status = 'active' LIMIT 1", [user.id, row.team_id])).rows[0];
    if (!member) throw unavailable();
    if (scope.documentType === "report" && row.cycle_status === "active") {
      const plan = (await db.query<{ review_status: string }>("SELECT review_status FROM investigation_plans WHERE session_id = $1 AND cycle_id = $2", [row.session_id, scope.cycleId])).rows[0];
      if (plan?.review_status !== "approved") throw unavailable();
    }
  }
  return { ...row, session_version: actor.session_version };
}

async function readTransaction<T>(user: Pick<SessionUser, "id" | "role">, scope: DocumentScope, read: (db: PoolClient, context: Access) => Promise<T>): Promise<T> {
  const pool = await getDb();
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const context = await access(db, user, scope);
    const result = await read(db, context);
    await db.query("COMMIT");
    // Recheck outside the snapshot, including a password/session reset during the read.
    const latest = await access(db, user, scope);
    if (latest.session_version !== context.session_version) throw new DocumentVersionError("권한이 변경되었습니다. 다시 로그인해 주세요.", 403);
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}

function revisionOption(row: Revision): VersionOption {
  return { ref: { kind: "revision", id: row.id }, label: versionActionLabel(row.action), eventAt: iso(row.created_at), actorName: row.actor_name };
}
type Filters = { cursor?: string; fromDate?: string; toDate?: string };
function dateBoundary(value: string | undefined, nextDay = false) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DocumentVersionError("날짜를 확인해 주세요.", 400);
  const time = Date.parse(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(time) || new Date(time + 9 * 3600000).toISOString().slice(0, 10) !== value) throw new DocumentVersionError("날짜를 확인해 주세요.", 400);
  return new Date(time + (nextDay ? 86400000 : 0)).toISOString();
}
export async function listDocumentVersions(user: Pick<SessionUser, "id" | "role">, scope: DocumentScope, filters: Filters = {}): Promise<VersionList> {
  const from = dateBoundary(filters.fromDate), to = dateBoundary(filters.toDate, true);
  if (from && to && from >= to) throw new DocumentVersionError("날짜 범위를 확인해 주세요.", 400);
  const key = fingerprint({ scope, from, to });
  let after: { time: string; id: string } | null = null;
  if (filters.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
      if (cursor.key !== key || typeof cursor.id !== "string" || cursor.id.length > 200 || typeof cursor.time !== "string" || !Number.isFinite(Date.parse(cursor.time))) throw new Error();
      after = cursor;
    } catch { throw new DocumentVersionError("목록을 처음부터 다시 불러와 주세요.", 400); }
  }
  return readTransaction(user, scope, async (db, context) => {
    // Use PostgreSQL's full timestamp precision in the cursor (JS Date loses microseconds).
    const rows = (await db.query<Revision & { cursor_time: string }>(
      `SELECT dr.id, dr.action, dr.created_at, dr.created_at::text AS cursor_time, u.name AS actor_name
         FROM document_revisions dr LEFT JOIN users u ON u.id = dr.changed_by
        WHERE dr.document_type = $1 AND dr.document_id = $2 AND dr.cycle_id = $3
          AND ($4::timestamptz IS NULL OR dr.created_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR dr.created_at < $5::timestamptz)
          AND ($6::timestamptz IS NULL OR dr.created_at < $6::timestamptz OR (dr.created_at = $6::timestamptz AND dr.id < $7))
        ORDER BY dr.created_at DESC, dr.id DESC LIMIT 31`,
      [scope.documentType, scope.documentId, scope.cycleId, from, to, after?.time ?? null, after?.id ?? null],
    )).rows;
    const history = rows.slice(0, 30).map(revisionOption);
    const fixed: VersionOption[] = [];
    if (context.current_cycle_id === scope.cycleId) {
      fixed.push({ ref: { kind: context.cycle_status === "active" ? "current" : "cycle_final" }, label: context.cycle_status === "active" ? "현재 서버 저장본" : "이 회차 최종 보존본", eventAt: null });
    } else if (context.cycle_status !== "active") {
      const endings = (await db.query<{ id: string }>("SELECT id FROM document_revisions WHERE document_type = $1 AND document_id = $2 AND cycle_id = $3 AND action = 'cycle_completed' LIMIT 1", [scope.documentType, scope.documentId, scope.cycleId])).rows;
      if (endings.length) fixed.push({ ref: { kind: "cycle_final" }, label: "이 회차 최종 보존본", eventAt: null });
    }
    const last = rows[29];
    return { scope, teamName: context.team_name, cycleTitle: context.cycle_title, fixed, history,
      nextCursor: rows.length > 30 ? Buffer.from(JSON.stringify({ key, time: last.cursor_time, id: last.id })).toString("base64url") : null };
  });
}

function formFields(definition: unknown): FormFieldDefinition[] | null {
  const data = object(definition);
  if (!data || !Array.isArray(data.fields)) return null;
  const kinds = new Set(["heading", "short_text", "long_text", "number", "date", "single_choice", "multiple_choice", "checkbox", "table"]);
  const ids = new Set<string>();
  for (const item of data.fields) {
    const field = object(item);
    if (!field || typeof field.id !== "string" || ids.has(field.id) || typeof field.label !== "string" || !kinds.has(String(field.kind))) return null;
    ids.add(field.id);
    if (field.kind === "table" && (!Array.isArray(field.columns) || field.columns.some(col => !object(col) || typeof col.id !== "string" || typeof col.label !== "string"))) return null;
    if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some(option => typeof option !== "string"))) return null;
  }
  return data.fields as FormFieldDefinition[];
}

async function resolveVersion(db: PoolClient, scope: DocumentScope, context: Access, ref: VersionRef): Promise<DocumentVersion> {
  let snapshot: Record<string, unknown> | null = null;
  let metadata: VersionOption;
  let sourceKey: string;
  let freshness: unknown = null;
  let definition: unknown;
  let isLive = false;
  let originalSource: unknown;
  if (ref.kind === "revision" || (ref.kind === "cycle_final" && context.current_cycle_id !== scope.cycleId)) {
    if (ref.kind === "cycle_final" && context.cycle_status === "active") throw unavailable();
    const rows = (await db.query<Revision>(
      `SELECT dr.id, dr.action, dr.snapshot, dr.created_at, u.name AS actor_name FROM document_revisions dr
       LEFT JOIN users u ON u.id = dr.changed_by
       WHERE dr.document_type = $1 AND dr.document_id = $2 AND dr.cycle_id = $3
         AND ${ref.kind === "revision" ? "dr.id = $4" : "dr.action = 'cycle_completed'"}
       ORDER BY dr.created_at DESC, dr.id DESC ${ref.kind === "revision" ? "LIMIT 1" : "LIMIT 2"}`,
      ref.kind === "revision" ? [scope.documentType, scope.documentId, scope.cycleId, ref.id] : [scope.documentType, scope.documentId, scope.cycleId],
    )).rows;
    if (!rows[0]) throw unavailable();
    if (rows.length > 1) throw new DocumentVersionError("최종 보존본을 확정할 수 없습니다. 개별 이력을 선택해 주세요.", 422);
    metadata = { ...revisionOption(rows[0]), ref };
    originalSource = rows[0].snapshot;
    snapshot = object(originalSource);
    definition = snapshot?.configDefinition;
    sourceKey = `revision:${rows[0].id}`;
  } else {
    if (context.current_cycle_id !== scope.cycleId || (ref.kind === "current" && context.cycle_status !== "active") || (ref.kind === "cycle_final" && context.cycle_status === "active")) throw unavailable();
    const row = (await db.query<{ form_data: unknown; status: string; teacher_feedback: string | null; updated_at: string; revision_stamp: string; definition: unknown }>(
      `SELECT d.form_data, ${scope.documentType === "plan" ? "d.review_status" : "d.status"} AS status, d.teacher_feedback,
              d.updated_at, ${scope.documentType === "report" ? "d.write_version::text" : "d.updated_at::text"} AS revision_stamp, v.definition
         FROM ${table(scope)} d LEFT JOIN club_config_versions v ON v.id = d.config_version_id
        WHERE d.id = $1 AND d.cycle_id = $2`, [scope.documentId, scope.cycleId],
    )).rows[0];
    if (!row) throw unavailable();
    const values = object(row.form_data);
    if (scope.documentType === "report" && values) {
      for (const field of (await db.query<{ field_key: string; value: string }>("SELECT field_key, value FROM report_fields WHERE report_id = $1", [scope.documentId])).rows) {
        Object.defineProperty(values, field.field_key, { value: field.value, enumerable: true, configurable: true, writable: true });
      }
    }
    const roles = scope.documentType === "report" ? (await db.query<{ userId: string; description: string }>(
      'SELECT user_id AS "userId", role_description AS description FROM report_member_roles WHERE report_id = $1 ORDER BY user_id', [scope.documentId],
    )).rows : [];
    snapshot = { formData: values, status: row.status, teacherFeedback: row.teacher_feedback, roles };
    originalSource = { ...snapshot, formData: row.form_data };
    metadata = { ref, label: ref.kind === "current" ? "현재 서버 저장본" : "이 회차 최종 보존본", eventAt: iso(row.updated_at) };
    definition = row.definition;
    freshness = row.revision_stamp;
    sourceKey = `document:${scope.documentId}:${scope.cycleId}`;
    isLive = true;
  }
  const issues: string[] = [];
  const values = object(snapshot?.formData);
  let valid = Boolean(snapshot && values);
  if (!valid) issues.push("원문 구조를 읽을 수 없어 이 버전의 차이를 계산하지 않았습니다.");
  let fields = formFields(definition);
  let definitionVerified = Boolean(fields);
  // Current school documents use the source-controlled fixed form. Historical plan
  // revisions did not capture it: labels are references, not invented historical definitions.
  if (!fields && !context.club_id) {
    fields = formFields(defaultClubConfigDefinition(scope.documentType));
    definitionVerified = isLive;
  }
  if (!definitionVerified) issues.push("당시 양식 정의가 없습니다. 항목명은 참고 표시이며 알 수 없는 값은 원문으로 남겼습니다.");
  const rawRoles = snapshot?.roles;
  const roles: DocumentVersion["roles"] = [];
  if (scope.documentType === "report") {
    if (!Array.isArray(rawRoles) || rawRoles.some(role => !object(role) || typeof role.userId !== "string" || typeof role.description !== "string") || new Set(rawRoles.map(role => role.userId)).size !== rawRoles.length) {
      issues.push("당시 팀원 역할을 확인할 수 없습니다. 현재 팀원이나 익명 역할로 추정하지 않았습니다.");
      valid = false;
    } else {
      for (const role of rawRoles) {
        const person = (await db.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [role.userId])).rows[0];
        roles.push({ userId: role.userId, description: role.description, label: person?.name ?? "이전 팀원" });
      }
    }
  }
  return { ...metadata, sourceKey, fingerprint: fingerprint({ scope, sourceKey, snapshot, definition, freshness }), capturedAt: new Date().toISOString(),
    fields: fields ?? [], definitionVerified, values: values ?? {}, roles, status: typeof (snapshot?.reviewStatus ?? snapshot?.status) === "string" ? String(snapshot?.reviewStatus ?? snapshot?.status) : null,
    feedback: typeof snapshot?.teacherFeedback === "string" ? snapshot.teacherFeedback : null, valid, issues,
    ...(!valid ? { unreadableSource: originalSource } : {}) };
}

export async function compareDocumentVersions(user: Pick<SessionUser, "id" | "role">, scope: DocumentScope, a: VersionRef, b: VersionRef, expected: { a?: string; b?: string } = {}) {
  return readTransaction(user, scope, async (db, context) => {
    const left = await resolveVersion(db, scope, context, a);
    const right = await resolveVersion(db, scope, context, b);
    if ((expected.a && expected.a !== left.fingerprint) || (expected.b && expected.b !== right.fingerprint)) {
      throw new DocumentVersionError("선택한 서버 저장본이 바뀌었습니다. 현재 저장본 다시 불러오기를 눌러 비교해 주세요.", 409);
    }
    return { scope, a: left, b: right };
  });
}
