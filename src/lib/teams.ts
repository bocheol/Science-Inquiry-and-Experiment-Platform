import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";

async function ensureSession(teamId: string) {
  const db = await getDb();
  const existing = await db.query<{ id: string }>("SELECT id FROM inquiry_sessions WHERE team_id = $1", [teamId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const sessionId = createId("session");
  const planId = createId("plan");
  await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ($1, $2)", [sessionId, teamId]);
  await db.query("INSERT INTO investigation_plans (id, session_id) VALUES ($1, $2)", [planId, sessionId]);
  await db.query("INSERT INTO reports (id, session_id) VALUES ($1, $2)", [`report_${sessionId}`, sessionId]);
  return sessionId;
}

export async function createTeam(actorId: string, classNumber: number, teamNumber: number) {
  const db = await getDb();
  const classResult = await db.query<{ id: string }>(
    "SELECT id FROM classes WHERE class_number = $1 AND academic_year = $2",
    [classNumber, Number(process.env.ACADEMIC_YEAR ?? 2026)],
  );
  const classId = classResult.rows[0]?.id;
  if (!classId) throw new Error("학급을 찾을 수 없습니다.");
  const teamId = `team_${Number(process.env.ACADEMIC_YEAR ?? 2026)}_${classNumber}_${teamNumber}`;
  await db.query(
    `INSERT INTO teams (id, class_id, team_number, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (class_id, team_number) DO UPDATE SET name = EXCLUDED.name`,
    [teamId, classId, teamNumber, `${teamNumber}조`],
  );
  await ensureSession(teamId);
  await audit(actorId, "team_created", "team", teamId, { classNumber, teamNumber });
  return teamId;
}

export async function assignStudent(actorId: string, studentId: string, teamId: string, asLeader = false) {
  const db = await getDb();
  const valid = await db.query(
    `SELECT u.id FROM users u JOIN teams t ON t.class_id = u.class_id
      WHERE u.id = $1 AND t.id = $2 AND u.role = 'student'`,
    [studentId, teamId],
  );
  if (!valid.rows[0]) throw new Error("학생과 팀의 학급이 다릅니다.");
  await db.query(
    `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND status = 'active' AND team_id <> $2`,
    [studentId, teamId],
  );
  const membership = await db.query(
    "SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2 AND status = 'active'",
    [studentId, teamId],
  );
  if (!membership.rows[0]) {
    await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $2, $3)", [createId("member"), teamId, studentId]);
  }
  if (asLeader) await db.query("UPDATE teams SET leader_user_id = $1 WHERE id = $2", [studentId, teamId]);
  await ensureSession(teamId);
  await audit(actorId, "student_assigned", "team", teamId, { studentId, asLeader });
}

export async function removeStudent(actorId: string, studentId: string, teamId: string) {
  const db = await getDb();
  await db.query(
    `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND team_id = $2 AND status = 'active'`,
    [studentId, teamId],
  );
  await db.query("UPDATE teams SET leader_user_id = NULL WHERE id = $1 AND leader_user_id = $2", [teamId, studentId]);
  await audit(actorId, "student_removed", "team", teamId, { studentId });
}

export async function setTeamLeader(actorId: string, teamId: string, studentId: string) {
  const db = await getDb();
  const membership = await db.query(
    "SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active'",
    [teamId, studentId],
  );
  if (!membership.rows[0]) throw new Error("현재 팀원만 팀장이 될 수 있습니다.");
  await db.query("UPDATE teams SET leader_user_id = $1 WHERE id = $2", [studentId, teamId]);
  await audit(actorId, "team_leader_set", "team", teamId, { studentId });
}
