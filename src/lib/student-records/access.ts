import type { Pool, PoolClient } from "pg";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { UserFacingError } from "@/lib/user-facing-error";
import type { SessionUser } from "@/lib/types";
import type { RecordSettings, RecordStudent } from "./model";

export type RecordActor = Pick<SessionUser, "id" | "role" | "mustChangePassword">;
export type RecordDb = Pick<Pool | PoolClient, "query">;
export class RecordError extends UserFacingError {
  constructor(message: string, readonly status = 400) { super(message); }
}
// Only historical/source denial can be hidden to start a fresh draft. A lost
// current account or assigned-class grant must still reject the request.
export class RecordEvidenceUnavailable extends RecordError {
  constructor(message: string) { super(message, 403); }
}
export const parseValue = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) as T : value;
export const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;

export async function assertRecordActor(db: RecordDb, actor: RecordActor, teacherOnly = false) {
  const row = (await db.query<{ role: string }>(`SELECT role FROM users WHERE id = $1 AND status = 'active'
    AND must_change_password = FALSE AND academic_year = $2`, [actor.id, ACADEMIC_YEAR])).rows[0];
  if (!row || row.role !== actor.role || actor.mustChangePassword || (teacherOnly && row.role !== "teacher")) {
    throw new RecordError("현재 계정으로 세특 자료에 접근할 수 없습니다.", 403);
  }
}

export async function assertRecordStudent(db: RecordDb, actor: RecordActor, studentId: string) {
  await assertRecordActor(db, actor);
  const student = (await db.query<{ id: string; name: string; login_id: string; class_id: string; class_number: number; status: string; teacher_id: string | null; journal_teacher_id: string | null }>(
    `SELECT s.id, s.name, s.login_id, s.class_id, c.class_number, s.status, a.teacher_id, j.teacher_id AS journal_teacher_id
     FROM users s JOIN classes c ON c.id = s.class_id
     LEFT JOIN record_teacher_classes a ON a.class_id = c.id
     LEFT JOIN class_journal_teacher_assignments j ON j.class_id = c.id AND j.teacher_id = $3
     WHERE s.id = $1 AND s.role = 'student' AND s.account_type = 'standard' AND s.academic_year = $2 AND c.academic_year = $2`, [studentId, ACADEMIC_YEAR, actor.id])).rows[0];
  // A records assignment never overrides a revoked private-journal grant.
  // Stored teacher prose can quote journals, so deny the whole teacher workspace
  // instead of returning only a superficially redacted evidence list.
  if (!student || (actor.role === "student" ? student.id !== actor.id : student.teacher_id !== actor.id || student.journal_teacher_id !== actor.id)) {
    throw new RecordError("본인 또는 담당 반의 학생 자료만 열 수 있습니다.", 403);
  }
  return student;
}

export async function assertRecordJournal(db: RecordDb, actor: RecordActor, studentId: string, journalId: string) {
  await assertRecordStudent(db, actor, studentId);
  const row = (await db.query<{ teacher_id: string | null }>(`SELECT a.teacher_id FROM experiment_journals j
    JOIN inquiry_sessions s ON s.id = j.session_id JOIN teams t ON t.id = s.team_id
    JOIN classes c ON c.id = t.class_id
    LEFT JOIN class_journal_teacher_assignments a ON a.class_id = c.id AND a.teacher_id = $3
    WHERE j.id = $1 AND j.student_id = $2 AND c.academic_year = $4`, [journalId, studentId, actor.id, ACADEMIC_YEAR])).rows[0];
  if (!row || (actor.role === "teacher" && row.teacher_id !== actor.id)) {
    throw new RecordEvidenceUnavailable("이 개인 일지의 조회 권한이 변경되었습니다. 담당 권한을 확인해 주세요.");
  }
}

// Historical prose/AI results cannot be safely separated from their evidence.
// Validate live source ownership and grants before returning the entire bundle.
export async function assertRecordEvidenceAccess(db: RecordDb, actor: RecordActor, studentId: string, evidence: unknown) {
  await assertRecordStudent(db, actor, studentId);
  if (!evidence || typeof evidence !== "object" || !("sources" in evidence) || !Array.isArray(evidence.sources)) {
    throw new RecordEvidenceUnavailable("저장된 검토본의 근거 범위를 확인할 수 없어 열람을 보류했습니다.");
  }
  const journals = new Set<string>();
  for (const source of evidence.sources) {
    if (!source || typeof source.id !== "string") throw new RecordEvidenceUnavailable("저장된 근거의 출처를 확인해 주세요.");
    if (source.id.startsWith("journal:")) journals.add(source.id.slice("journal:".length));
    else if (source.attachments?.some((item: { url?: string }) => item.url?.startsWith("/api/records/journal-images/"))) {
      throw new RecordEvidenceUnavailable("저장된 사진 근거의 소유자를 확인할 수 없습니다.");
    }
  }
  for (const journalId of journals) await assertRecordJournal(db, actor, studentId, journalId);
}

export async function recordTransaction<T>(actor: RecordActor, studentId: string, run: (db: PoolClient) => Promise<T>) {
  const client = await (await getDb()).connect();
  try {
    await client.query("BEGIN");
    // Journal grant changes lock classes before users. Use the same order so a
    // revocation that wins the class lock is visible before any records write.
    const target = (await client.query<{ class_id: string }>("SELECT class_id FROM users WHERE id = $1", [studentId])).rows[0];
    if (!target?.class_id) throw new RecordError("학생의 담당 반을 확인해 주세요.", 403);
    await client.query("SELECT id FROM classes WHERE id = $1 FOR SHARE", [target.class_id]);
    // Permission parents are read locks; only the student being changed needs
    // an exclusive row lock. Unrelated students can save during a slow export.
    for (const id of [...new Set([actor.id, studentId])].sort()) {
      await client.query("SELECT id FROM users WHERE id = $1 FOR " + (id === studentId ? "UPDATE" : "SHARE"), [id]);
    }
    const student = await assertRecordStudent(client, actor, studentId);
    if (student.class_id !== target.class_id) throw new RecordError("학생의 반이 변경되었습니다. 다시 확인해 주세요.", 409);
    await client.query("SELECT class_id FROM record_teacher_classes WHERE class_id = $1 FOR SHARE", [student.class_id]);
    await assertRecordStudent(client, actor, studentId);
    await client.query("INSERT INTO record_submissions (student_id) VALUES ($1) ON CONFLICT (student_id) DO NOTHING", [studentId]);
    await client.query("SELECT student_id FROM record_submissions WHERE student_id = $1 FOR UPDATE", [studentId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

// Auth must be prepared before entering this boundary. Hold the same parent
// locks used by setJournalTeacherClasses until the external request completes.
// All students share one transaction; a revocation cannot split a batch.
// This orders new transmissions; it cannot recall bytes already sent to Google.
export async function withRecordTransmissionAccess<T>(actor: RecordActor, items: { studentId: string; evidence?: unknown }[], send: () => Promise<T>) {
  if (!items.length) throw new RecordError("전송할 학생 자료를 확인해 주세요.");
  const client = await (await getDb()).connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const targets = new Map<string, string>();
    for (const studentId of [...new Set(items.map(item => item.studentId))].sort()) {
      const target = (await client.query<{ class_id: string }>("SELECT class_id FROM users WHERE id = $1", [studentId])).rows[0];
      if (!target?.class_id) throw new RecordError("학생의 담당 반을 확인해 주세요.", 403);
      targets.set(studentId, target.class_id);
    }
    for (const classId of [...new Set(targets.values())].sort()) {
      await client.query("SELECT id FROM classes WHERE id = $1 FOR SHARE", [classId]);
    }
    for (const id of [...new Set([actor.id, ...items.map(item => item.studentId)])].sort()) {
      await client.query("SELECT id FROM users WHERE id = $1 FOR SHARE", [id]);
    }
    // Also serialize direct assignment-row updates, not only the UI setter.
    for (const classId of [...new Set(targets.values())].sort()) {
      await client.query("SELECT class_id FROM record_teacher_classes WHERE class_id = $1 FOR SHARE", [classId]);
    }
    // Keep the actor's historical journal grants locked too: saved evidence can
    // reference a previous class. These rows do not lock unrelated student saves.
    await client.query("SELECT class_id FROM class_journal_teacher_assignments WHERE teacher_id = $1 ORDER BY class_id FOR SHARE", [actor.id]);
    for (const item of items) {
      const student = await assertRecordStudent(client, actor, item.studentId);
      if (student.class_id !== targets.get(item.studentId)) throw new RecordError("학생의 반이 변경되었습니다. 다시 확인해 주세요.", 409);
      if ("evidence" in item) await assertRecordEvidenceAccess(client, actor, item.studentId, item.evidence);
    }
    const result = await send();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error && typeof error === "object" && "code" in error && (error.code === "55P03" || error.code === "57014")) {
      throw new RecordError("권한 변경 또는 저장 처리를 기다리는 중입니다. 잠시 뒤 같은 요청으로 다시 확인해 주세요.", 503);
    }
    throw error;
  }
  finally { client.release(); }
}

export async function teacherRecordStudents(actor: RecordActor): Promise<RecordStudent[]> {
  const db = await getDb();
  await assertRecordActor(db, actor, true);
  const rows = (await db.query<{ id: string; name: string; login_id: string; class_number: number; status: string; submission_status: string | null; draft_status: string | null }>(
    `SELECT s.id, s.name, s.login_id, c.class_number, s.status, r.status AS submission_status, d.status AS draft_status
     FROM record_teacher_classes a JOIN classes c ON c.id = a.class_id
     JOIN class_journal_teacher_assignments j ON j.class_id = c.id AND j.teacher_id = a.teacher_id
     JOIN users s ON s.class_id = c.id AND s.role = 'student' AND s.account_type = 'standard'
     LEFT JOIN record_submissions r ON r.student_id = s.id LEFT JOIN record_drafts d ON d.student_id = s.id
     WHERE a.teacher_id = $1 AND c.academic_year = $2 AND s.academic_year = $2 ORDER BY c.class_number, s.login_id`, [actor.id, ACADEMIC_YEAR])).rows;
  return rows.map(s => ({ id: s.id, name: s.name, loginId: s.login_id, classNumber: s.class_number, status: s.status, submissionStatus: s.submission_status ?? "draft", draftStatus: s.draft_status ?? "draft" }));
}

// Private file identifiers belong in server configuration, never the repository.
const DESTINATION_ENV: Record<string, string> = {
  teacher1: "RECORDS_SPREADSHEET_TEACHER1_ID",
  teacher2: "RECORDS_SPREADSHEET_TEACHER2_ID",
  teacher3: "RECORDS_SPREADSHEET_TEACHER3_ID",
  teacher4: "RECORDS_SPREADSHEET_TEACHER4_ID",
};
export async function recordSettings(db: RecordDb, teacherId: string | null): Promise<RecordSettings> {
  if (!teacherId) return { revision: 0, style: "", opensAt: null, deadlineAt: null, spreadsheetId: "", folderId: "" };
  const row = (await db.query<{ revision: number; style: string; opens_at: Date | null; deadline_at: Date | null; spreadsheet_id: string; folder_id: string; login_id: string }>(
    `SELECT u.login_id, s.revision, s.style, s.opens_at, s.deadline_at, s.spreadsheet_id, s.folder_id
     FROM users u LEFT JOIN record_teacher_settings s ON s.teacher_id = u.id WHERE u.id = $1`, [teacherId])).rows[0];
  const matchingYear = Number(process.env.RECORDS_DESTINATION_YEAR) === ACADEMIC_YEAR;
  const destinationKey = DESTINATION_ENV[row?.login_id];
  return { revision: row?.revision ?? 0, style: row?.style ?? "", opensAt: iso(row?.opens_at ?? null), deadlineAt: iso(row?.deadline_at ?? null),
    spreadsheetId: row?.spreadsheet_id || (matchingYear && destinationKey ? process.env[destinationKey] : "") || "",
    folderId: row?.folder_id || (matchingYear ? process.env.RECORDS_DRIVE_FOLDER_ID : "") || "" };
}

export async function assertRecordWritable(db: RecordDb, actor: RecordActor, studentId: string) {
  const student = await assertRecordStudent(db, actor, studentId);
  if (actor.role === "teacher") return;
  if (!student.teacher_id) throw new RecordError("담당 교사 연결을 확인한 뒤 제출할 수 있습니다.");
  const settings = await recordSettings(db, student.teacher_id);
  const row = (await db.query<{ reopened_until: Date | null }>("SELECT reopened_until FROM record_submissions WHERE student_id = $1", [studentId])).rows[0];
  const now = Date.now();
  if (row?.reopened_until && new Date(row.reopened_until).getTime() > now) return;
  if (settings.opensAt && new Date(settings.opensAt).getTime() > now) throw new RecordError("아직 자료 접수 기간이 아닙니다.", 409);
  if (settings.deadlineAt && new Date(settings.deadlineAt).getTime() < now) throw new RecordError("제출 기한이 지났습니다. 선생님께 수정 요청을 해 주세요.", 409);
}
