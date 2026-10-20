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
  const student = (await db.query<{ id: string; name: string; login_id: string; class_id: string; class_number: number; status: string; teacher_id: string | null }>(
    `SELECT s.id, s.name, s.login_id, s.class_id, c.class_number, s.status, a.teacher_id
     FROM users s JOIN classes c ON c.id = s.class_id
     LEFT JOIN record_teacher_classes a ON a.class_id = c.id
     WHERE s.id = $1 AND s.role = 'student' AND s.account_type = 'standard' AND s.academic_year = $2 AND c.academic_year = $2`, [studentId, ACADEMIC_YEAR])).rows[0];
  if (!student || (actor.role === "student" ? student.id !== actor.id : student.teacher_id !== actor.id)) {
    throw new RecordError("본인 또는 담당 반의 학생 자료만 열 수 있습니다.", 403);
  }
  return student;
}

export async function recordTransaction<T>(actor: RecordActor, studentId: string, run: (db: PoolClient) => Promise<T>) {
  const client = await (await getDb()).connect();
  try {
    await client.query("BEGIN");
    // Match other account-management writers: lock the live user before checking authority.
    for (const id of [...new Set([actor.id, studentId])].sort()) await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
    const student = await assertRecordStudent(client, actor, studentId);
    await client.query("SELECT class_id FROM record_teacher_classes WHERE class_id = $1 FOR UPDATE", [student.class_id]);
    await assertRecordStudent(client, actor, studentId);
    await client.query("INSERT INTO record_submissions (student_id) VALUES ($1) ON CONFLICT (student_id) DO NOTHING", [studentId]);
    await client.query("SELECT student_id FROM record_submissions WHERE student_id = $1 FOR UPDATE", [studentId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function teacherRecordStudents(actor: RecordActor): Promise<RecordStudent[]> {
  const db = await getDb();
  await assertRecordActor(db, actor, true);
  const rows = (await db.query<{ id: string; name: string; login_id: string; class_number: number; status: string; submission_status: string | null; draft_status: string | null }>(
    `SELECT s.id, s.name, s.login_id, c.class_number, s.status, r.status AS submission_status, d.status AS draft_status
     FROM record_teacher_classes a JOIN classes c ON c.id = a.class_id
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
