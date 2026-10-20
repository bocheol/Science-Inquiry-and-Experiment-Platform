import type { Pool, PoolClient } from "pg";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { UserFacingError } from "@/lib/user-facing-error";

type Queryable = Pick<Pool | PoolClient, "query">;

export class PrivateJournalAccessError extends UserFacingError {
  readonly status = 403;
  constructor() { super("이 개인 일지를 볼 교사 권한이 없습니다."); }
}

// Always resolve live account and assignment state, never trust an old client role.
export async function canReadTeamJournals(db: Queryable, teacherId: string, teamId: string) {
  const result = await db.query(`SELECT t.id FROM teams t
    JOIN users u ON u.id = $1 AND u.role = 'teacher' AND u.status = 'active'
      AND u.must_change_password = FALSE AND u.academic_year = $3
    LEFT JOIN classes c ON c.id = t.class_id
    LEFT JOIN clubs cl ON cl.id = t.club_id
    LEFT JOIN class_journal_teacher_assignments ca ON ca.class_id = c.id AND ca.teacher_id = u.id
    LEFT JOIN club_teacher_assignments coa ON coa.club_id = cl.id AND coa.teacher_id = u.id
    WHERE t.id = $2 AND COALESCE(c.academic_year, cl.academic_year) = $3
      AND (u.is_master OR (c.id IS NOT NULL AND ca.teacher_id IS NOT NULL)
        OR (cl.id IS NOT NULL AND coa.teacher_id IS NOT NULL))`, [teacherId, teamId, ACADEMIC_YEAR]);
  return result.rows.length > 0;
}

export async function assertTeacherJournalAccess(db: Queryable, teacherId: string, teamId: string) {
  if (!(await canReadTeamJournals(db, teacherId, teamId))) throw new PrivateJournalAccessError();
}

export async function assertTeacherJournalClassAccess(db: Queryable, teacherId: string, classId: string) {
  const result = await db.query(`SELECT u.id FROM users u JOIN classes c ON c.id = $2
    LEFT JOIN class_journal_teacher_assignments a ON a.class_id = c.id AND a.teacher_id = u.id
    WHERE u.id = $1 AND u.role = 'teacher' AND u.status = 'active' AND u.must_change_password = FALSE
      AND u.academic_year = $3 AND c.academic_year = $3 AND (u.is_master OR a.teacher_id IS NOT NULL)`, [teacherId, classId, ACADEMIC_YEAR]);
  if (!result.rows.length) throw new PrivateJournalAccessError();
}

export async function journalTeacherClasses(db: Queryable, teacherId: string) {
  return (await db.query<{ id: string; class_number: number }>(`SELECT c.id, c.class_number FROM classes c
    JOIN users u ON u.id = $1 AND u.role = 'teacher' AND u.status = 'active'
      AND u.must_change_password = FALSE AND u.academic_year = $2
    LEFT JOIN class_journal_teacher_assignments a ON a.class_id = c.id AND a.teacher_id = u.id
    WHERE c.academic_year = $2 AND (u.is_master OR a.teacher_id IS NOT NULL) ORDER BY c.class_number`, [teacherId, ACADEMIC_YEAR])).rows;
}
