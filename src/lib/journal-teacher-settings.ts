import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { assertMasterActor } from "@/lib/master-accounts";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { UserFacingError } from "@/lib/user-facing-error";
import { createId } from "@/lib/id";

export async function getJournalTeacherSettings(actorId: string) {
  await assertMasterActor(actorId);
  const db = await getDb();
  const classes = (await db.query<{ id: string; class_number: number }>("SELECT id, class_number FROM classes WHERE academic_year = $1 ORDER BY class_number", [ACADEMIC_YEAR])).rows;
  const teachers = (await db.query<{ id: string; name: string; login_id: string; is_master: boolean }>("SELECT id, name, login_id, is_master FROM users WHERE academic_year = $1 AND role = 'teacher' AND status = 'active' ORDER BY login_id", [ACADEMIC_YEAR])).rows;
  const assignments = (await db.query<{ teacher_id: string; class_id: string }>("SELECT a.teacher_id, a.class_id FROM class_journal_teacher_assignments a JOIN classes c ON c.id = a.class_id WHERE c.academic_year = $1", [ACADEMIC_YEAR])).rows;
  return { classes, teachers: teachers.map(teacher => ({ ...teacher, classIds: assignments.filter(a => a.teacher_id === teacher.id).map(a => a.class_id).sort() })) };
}

export async function setJournalTeacherClasses(actorId: string, teacherId: string, classIds: string[], expectedClassIds: string[]) {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Same parent-before-user ordering as exam generation.
    const classes = (await client.query<{ id: string }>("SELECT id FROM classes WHERE academic_year = $1 ORDER BY id FOR UPDATE", [ACADEMIC_YEAR])).rows;
    for (const id of [...new Set([actorId, teacherId])].sort()) await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
    const actor = (await client.query("SELECT id FROM users WHERE id = $1 AND is_master = TRUE AND role = 'teacher' AND status = 'active' AND must_change_password = FALSE AND academic_year = $2", [actorId, ACADEMIC_YEAR])).rows[0];
    const target = (await client.query("SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND status = 'active' AND academic_year = $2", [teacherId, ACADEMIC_YEAR])).rows[0];
    if (!actor || !target) throw new UserFacingError("활성 마스터와 교사 계정을 확인해 주세요.");
    if (classIds.some(id => !classes.some(c => c.id === id)) || new Set(classIds).size !== classIds.length) throw new UserFacingError("현재 학년도 학급을 선택해 주세요.");
    const current = (await client.query<{ class_id: string }>("SELECT class_id FROM class_journal_teacher_assignments WHERE teacher_id = $1", [teacherId])).rows.map(a => a.class_id).filter(id => classes.some(c => c.id === id)).sort();
    if (JSON.stringify(current) !== JSON.stringify([...expectedClassIds].sort())) throw new FormWriteConflict("다른 화면에서 교사 권한을 변경했습니다. 최신 목록을 불러와 다시 확인해 주세요.");
    for (const c of classes) await client.query("DELETE FROM class_journal_teacher_assignments WHERE teacher_id = $1 AND class_id = $2", [teacherId, c.id]);
    for (const id of classIds) await client.query("INSERT INTO class_journal_teacher_assignments (teacher_id, class_id) VALUES ($1, $2)", [teacherId, id]);
    await client.query("INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,detail) VALUES ($1,$2,'journal_teacher_scope_changed','user',$3,$4)", [createId("audit"), actorId, teacherId, JSON.stringify({ before: current, after: [...classIds].sort() })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
