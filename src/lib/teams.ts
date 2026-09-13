import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import type { PoolClient } from "pg";
import { lockStudentTeams } from "@/lib/team-mutation-locks";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { UserFacingError } from "@/lib/user-facing-error";

async function assertCurrentYearStudentTeam(db: Pick<PoolClient, "query">, studentId: string, teamId: string) {
  const target = await db.query(
    `SELECT t.id FROM teams t JOIN users u ON u.id = $1
      LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
     WHERE t.id = $2 AND u.role = 'student' AND u.academic_year = $3
       AND COALESCE(c.academic_year, cl.academic_year) = $3`, [studentId, teamId, ACADEMIC_YEAR],
  );
  if (!target.rows.length) throw new UserFacingError("현재 학년도의 학생과 팀만 변경할 수 있습니다.");
}

export async function ensureSession(db: Pick<PoolClient, "query">, teamId: string) {
  const existing = await db.query<{ id: string }>("SELECT id FROM inquiry_sessions WHERE team_id = $1", [teamId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const sessionId = createId("session");
  const planId = createId("plan");
  await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ($1, $2)", [sessionId, teamId]);
  const cycleId = await ensureInitialCycle(db, sessionId);
  await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id) VALUES ($1, $2, $3)", [planId, sessionId, cycleId]);
  await db.query("INSERT INTO reports (id, session_id, cycle_id) VALUES ($1, $2, $3)", [`report_${sessionId}`, sessionId, cycleId]);
  return sessionId;
}

export async function createTeam(actorId: string, classNumber: number, teamNumber: number) {
  const client = await (await getDb()).connect();
  let teamId: string;
  try {
    await client.query("BEGIN");
    const classId = (await client.query<{ id: string }>(
      "SELECT id FROM classes WHERE class_number = $1 AND academic_year = $2 FOR UPDATE",
      [classNumber, Number(process.env.ACADEMIC_YEAR ?? 2026)],
    )).rows[0]?.id;
    if (!classId) throw new UserFacingError("학급을 찾을 수 없습니다.");
    const existing = (await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM teams WHERE class_id = $1 AND team_number = $2 FOR UPDATE", [classId, teamNumber],
    )).rows[0];
    if (existing?.status === "archived") throw new UserFacingError("같은 조 번호의 보관된 팀이 있습니다. 보관 팀 목록에서 먼저 복원해 주세요.");
    teamId = existing?.id ?? `team_${Number(process.env.ACADEMIC_YEAR ?? 2026)}_${classNumber}_${teamNumber}`;
    if (!existing) await client.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ($1,$2,$3,$4)", [teamId, classId, teamNumber, `${teamNumber}조`]);
    await ensureSession(client, teamId);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(actorId, "team_created", "team", teamId, { classNumber, teamNumber });
  return teamId;
}

export async function assignStudent(actorId: string, studentId: string, teamId: string, asLeader = false) {
  const client = await (await getDb()).connect();
  try {
  await client.query("BEGIN");
  await lockStudentTeams(client, studentId, [teamId]);
  await assertCurrentYearStudentTeam(client, studentId, teamId);
  const db = client;
  const valid = await db.query(
    `SELECT u.id FROM users u JOIN teams t ON t.class_id = u.class_id
      WHERE u.id = $1 AND t.id = $2 AND t.club_id IS NULL AND u.role = 'student' AND u.status = 'active' AND t.status = 'active'`,
    [studentId, teamId],
  );
  if (!valid.rows[0]) throw new UserFacingError("활성 학생과 활성 팀의 학급이 같은지 확인해 주세요.");
  await db.query(
    `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND status = 'active' AND team_id <> $2
        AND team_id IN (SELECT t.id FROM teams t JOIN classes c ON c.id = t.class_id
          WHERE t.club_id IS NULL AND c.academic_year = $3)`,
    [studentId, teamId, ACADEMIC_YEAR],
  );
  await db.query("UPDATE teams SET leader_user_id = NULL WHERE club_id IS NULL AND id <> $1 AND leader_user_id = $2 AND class_id IN (SELECT id FROM classes WHERE academic_year = $3)", [teamId, studentId, ACADEMIC_YEAR]);
  const membership = await db.query(
    "SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2 AND status = 'active'",
    [studentId, teamId],
  );
  if (!membership.rows[0]) {
    await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $2, $3)", [createId("member"), teamId, studentId]);
  }
  if (asLeader) await db.query("UPDATE teams SET leader_user_id = $1 WHERE id = $2", [studentId, teamId]);
  await ensureSession(client, teamId);
  await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(actorId, "student_assigned", "team", teamId, { studentId, asLeader });
}

export async function removeStudent(actorId: string, studentId: string, teamId: string) {
  const client = await (await getDb()).connect();
  try {
  await client.query("BEGIN");
  await lockStudentTeams(client, studentId, [teamId]);
  await assertCurrentYearStudentTeam(client, studentId, teamId);
  const db = client;
  await db.query(
    `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND team_id = $2 AND status = 'active'`,
    [studentId, teamId],
  );
  await db.query("UPDATE teams SET leader_user_id = NULL WHERE id = $1 AND leader_user_id = $2", [teamId, studentId]);
  await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(actorId, "student_removed", "team", teamId, { studentId });
}

export async function setTeamLeader(actorId: string, teamId: string, studentId: string) {
  const client = await (await getDb()).connect();
  try {
  await client.query("BEGIN");
  await lockStudentTeams(client, studentId, [teamId]);
  await assertCurrentYearStudentTeam(client, studentId, teamId);
  const db = client;
  const membership = await db.query(
    `SELECT tm.id FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.user_id = $2 AND tm.status = 'active' AND t.status = 'active' AND u.status = 'active' AND u.role = 'student'`,
    [teamId, studentId],
  );
  if (!membership.rows[0]) throw new UserFacingError("현재 팀원만 팀장이 될 수 있습니다.");
  await db.query("UPDATE teams SET leader_user_id = $1 WHERE id = $2", [studentId, teamId]);
  await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await audit(actorId, "team_leader_set", "team", teamId, { studentId });
}

export async function archiveTeam(actorId: string, teamId: string, confirmation: string) {
  const db = await getDb();
  const result = await db.query<{ name: string; class_number: number; club_name: string | null; status: string }>(
    `SELECT t.name, c.class_number, cl.name AS club_name, t.status
       FROM teams t LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
      WHERE t.id = $1 AND COALESCE(c.academic_year, cl.academic_year) = $2`,
    [teamId, ACADEMIC_YEAR],
  );
  const team = result.rows[0];
  if (!team) throw new UserFacingError("팀을 찾을 수 없습니다.");
  if (team.status !== "active") throw new UserFacingError("이미 보관된 팀입니다.");
  const expected = `${team.club_name ?? `${team.class_number}반`} ${team.name}`;
  if (confirmation.trim() !== expected) throw new UserFacingError(`확인 문구로 '${expected}'을(를) 정확히 입력해 주세요.`);
  await db.query(
    `UPDATE teams SET status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_by = $1
      WHERE id = $2 AND status = 'active'`,
    [actorId, teamId],
  );
  await audit(actorId, "team_archived", "team", teamId, { confirmationMatched: true });
}

export async function restoreTeam(actorId: string, teamId: string) {
  const db = await getDb();
  const restored = await db.query<{ id: string }>(
    `UPDATE teams SET status = 'active', archived_at = NULL, archived_by = NULL
      WHERE id = $1 AND status = 'archived'
        AND id IN (SELECT t.id FROM teams t LEFT JOIN classes c ON c.id = t.class_id
          LEFT JOIN clubs cl ON cl.id = t.club_id WHERE COALESCE(c.academic_year, cl.academic_year) = $2)
      RETURNING id`,
    [teamId, ACADEMIC_YEAR],
  );
  if (!restored.rows[0]) throw new UserFacingError("보관된 팀을 찾을 수 없습니다.");
  await audit(actorId, "team_restored", "team", teamId);
}
