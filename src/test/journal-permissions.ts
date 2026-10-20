import type { Pool } from "pg";
/** Explicit synthetic fixture permission; never grants permission in production code. */
export async function grantTestJournalClasses(db: Pool, teacherId = "teacher_bootstrap", classId?: string) {
  await db.query(`INSERT INTO class_journal_teacher_assignments (class_id,teacher_id)
    SELECT id,$1 FROM classes WHERE academic_year = 2026 AND ($2::text IS NULL OR id = $2)
    ON CONFLICT (class_id,teacher_id) DO NOTHING`, [teacherId, classId ?? null]);
}
