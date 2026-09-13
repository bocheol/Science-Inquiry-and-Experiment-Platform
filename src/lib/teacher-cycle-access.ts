import type { PoolClient } from "pg";

// Call only after locking the session and cycle, in the same write transaction.
export async function lockTeacherCycleAccess(db: PoolClient, cycleId: string, teacherId: string) {
  const target = (await db.query<{ team_id: string }>(
    `SELECT s.team_id FROM inquiry_cycles c JOIN inquiry_sessions s ON s.id = c.session_id WHERE c.id = $1`, [cycleId],
  )).rows[0];
  if (!target) throw new Error("탐구 회차를 찾을 수 없습니다.");
  const actor = (await db.query<{ role: string; status: string; must_change_password: boolean; is_master: boolean }>(
    "SELECT role, status, must_change_password, is_master FROM users WHERE id = $1 FOR UPDATE", [teacherId],
  )).rows[0];
  if (!actor || actor.role !== "teacher" || actor.status !== "active" || actor.must_change_password) throw new Error("이 탐구 회차를 관리할 권한이 없습니다.");
  const team = (await db.query<{ status: string; club_id: string | null }>(
    "SELECT status, club_id FROM teams WHERE id = $1 FOR UPDATE", [target.team_id],
  )).rows[0];
  if (!team || team.status !== "active") throw new Error("활성 팀의 탐구 회차만 관리할 수 있습니다.");
  if (team.club_id && !actor.is_master) {
    const assignment = await db.query("SELECT teacher_id FROM club_teacher_assignments WHERE club_id = $1 AND teacher_id = $2 FOR UPDATE", [team.club_id, teacherId]);
    if (!assignment.rows.length) throw new Error("이 탐구 회차를 관리할 권한이 없습니다.");
  }
}
