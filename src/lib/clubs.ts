import { hash } from "bcryptjs";
import { audit, getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { createId } from "@/lib/id";
import { generateTemporaryPassword } from "@/lib/passwords";

export async function assertTeacherId(actorId: string) {
  const db = await getDb();
  const result = await db.query("SELECT id FROM users WHERE id = $1 AND role = 'teacher' AND status = 'active' AND must_change_password = FALSE", [actorId]);
  if (!result.rows[0]) throw new Error("교사 권한이 필요합니다.");
}

export async function createClub(actorId: string, name: string) {
  await assertTeacherId(actorId);
  name = name.trim();
  if (!name || name.length > 60) throw new Error("동아리 이름을 60자 이내로 입력해 주세요.");
  const db = await getDb();
  const id = createId("club");
  await db.query("INSERT INTO clubs (id, academic_year, name, created_by) VALUES ($1, $2, $3, $4)", [id, ACADEMIC_YEAR, name, actorId]);
  await audit(actorId, "club_created", "club", id);
  return id;
}

async function assertClub(clubId: string) {
  const db = await getDb();
  const found = await db.query("SELECT id FROM clubs WHERE id = $1 AND academic_year = $2", [clubId, ACADEMIC_YEAR]);
  if (!found.rows[0]) throw new Error("동아리를 찾을 수 없습니다.");
}

export async function createClubTeam(actorId: string, clubId: string, name: string) {
  await assertTeacherId(actorId); await assertClub(clubId);
  name = name.trim();
  if (!name || name.length > 60) throw new Error("팀 이름을 60자 이내로 입력해 주세요.");
  const db = await getDb(); const client = await db.connect();
  const teamId = createId("team"); const sessionId = createId("session");
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM clubs WHERE id = $1 FOR UPDATE", [clubId]);
    const count = await client.query<{ next: number }>("SELECT COALESCE(MAX(team_number), 0) + 1 AS next FROM teams WHERE club_id = $1", [clubId]);
    await client.query("INSERT INTO teams (id, club_id, team_number, name) VALUES ($1, $2, $3, $4)", [teamId, clubId, count.rows[0].next, name]);
    await client.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ($1, $2)", [sessionId, teamId]);
    await client.query("INSERT INTO investigation_plans (id, session_id) VALUES ($1, $2)", [createId("plan"), sessionId]);
    await client.query("INSERT INTO reports (id, session_id) VALUES ($1, $2)", [createId("report"), sessionId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(actorId, "club_team_created", "team", teamId);
  return teamId;
}

export async function enrollClubStudent(actorId: string, clubId: string, loginId: string, name: string) {
  await assertTeacherId(actorId); await assertClub(clubId);
  loginId = loginId.trim(); name = name.trim();
  if (!/^[12](0[1-9]|[1-9][0-9])(0[1-9]|[1-9][0-9])$/.test(loginId)) throw new Error("1·2학년의 5자리 학번을 입력해 주세요.");
  const db = await getDb();
  const client = await db.connect();
  try {
  await client.query('BEGIN');
  // Registration in one club is serialized, and account + membership commit together.
  await client.query('SELECT id FROM clubs WHERE id = $1 FOR UPDATE', [clubId]);
  const existing = await client.query<{ id: string; role: string; status: string }>("SELECT id, role, status FROM users WHERE academic_year = $1 AND login_id = $2 FOR UPDATE", [ACADEMIC_YEAR, loginId]);
  let studentId = existing.rows[0]?.id; let temporaryPassword: string | null = null;
  if (existing.rows[0] && (existing.rows[0].role !== "student" || existing.rows[0].status !== "active")) throw new Error("활성 학생 계정인지 확인해 주세요. 비활성 계정은 먼저 복원해 주세요.");
  if (!studentId) {
    if (!name || name.length > 80) throw new Error("새 학생의 이름을 입력해 주세요.");
    if (loginId.startsWith("1")) throw new Error("1학년 학생은 수업 학생 관리에서 먼저 등록한 뒤 동아리에 추가해 주세요.");
    studentId = createId("user"); temporaryPassword = generateTemporaryPassword();
    await client.query("INSERT INTO users (id, name, login_id, academic_year, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, 'student', $5, TRUE)", [studentId, name, loginId, ACADEMIC_YEAR, await hash(temporaryPassword, 12)]);
  }
  await client.query("INSERT INTO club_members (club_id, user_id) VALUES ($1, $2) ON CONFLICT (club_id, user_id) DO UPDATE SET status = 'active', left_at = NULL", [clubId, studentId]);
  await client.query('COMMIT');
  await audit(actorId, "club_student_enrolled", "club", clubId, { studentId });
  return { studentId, loginId, temporaryPassword };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function assignClubStudent(actorId: string, clubId: string, studentId: string, teamId: string, leader = false) {
  await assertTeacherId(actorId); await assertClub(clubId);
  const db = await getDb(); const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [studentId]);
    const valid = await client.query("SELECT u.id FROM users u JOIN club_members cm ON cm.user_id = u.id JOIN teams t ON t.club_id = cm.club_id WHERE u.id = $1 AND cm.club_id = $2 AND t.id = $3 AND u.status = 'active' AND cm.status = 'active' AND t.status = 'active'", [studentId, clubId, teamId]);
    if (!valid.rows[0]) throw new Error("같은 동아리의 활성 학생과 팀을 선택해 주세요.");
    await client.query("UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND status = 'active' AND team_id <> $2 AND team_id IN (SELECT id FROM teams WHERE club_id = $3)", [studentId, teamId, clubId]);
    await client.query("UPDATE teams SET leader_user_id = NULL WHERE club_id = $1 AND id <> $2 AND leader_user_id = $3", [clubId, teamId, studentId]);
    const found = await client.query("SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2 AND status = 'active'", [studentId, teamId]);
    if (!found.rows[0]) await client.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $2, $3)", [createId("member"), teamId, studentId]);
    if (leader) await client.query("UPDATE teams SET leader_user_id = $1 WHERE id = $2", [studentId, teamId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(actorId, "club_student_assigned", "team", teamId, { studentId, leader });
}

export async function leaveClub(actorId: string, clubId: string, studentId: string) {
  await assertTeacherId(actorId); await assertClub(clubId);
  const db = await getDb(); const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [studentId]);
    await client.query("UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND status = 'active' AND team_id IN (SELECT id FROM teams WHERE club_id = $2)", [studentId, clubId]);
    await client.query("UPDATE teams SET leader_user_id = NULL WHERE club_id = $1 AND leader_user_id = $2", [clubId, studentId]);
    await client.query("UPDATE club_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP WHERE club_id = $1 AND user_id = $2", [clubId, studentId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await audit(actorId, "club_student_left", "club", clubId, { studentId });
}

export async function getClubManagement(actorId: string) {
  await assertTeacherId(actorId);
  const db = await getDb();
  const clubs = await db.query<{ id: string; name: string }>("SELECT id, name FROM clubs WHERE academic_year = $1 ORDER BY created_at", [ACADEMIC_YEAR]);
  const teams = await db.query<{ id: string; club_id: string; name: string; status: string; leader_user_id: string | null; topic: string | null; plan_status: string; report_status: string }>(`SELECT t.id, t.club_id, t.name, t.status, t.leader_user_id, s.selected_topic AS topic, p.review_status AS plan_status, r.status AS report_status
    FROM teams t JOIN clubs c ON c.id = t.club_id LEFT JOIN inquiry_sessions s ON s.team_id = t.id LEFT JOIN investigation_plans p ON p.session_id = s.id LEFT JOIN reports r ON r.session_id = s.id WHERE c.academic_year = $1 ORDER BY t.team_number`, [ACADEMIC_YEAR]);
  const students = await db.query<{ id: string; club_id: string; name: string; login_id: string; status: string; account_status: string }>("SELECT u.id, cm.club_id, u.name, u.login_id, cm.status, u.status AS account_status FROM club_members cm JOIN users u ON u.id = cm.user_id JOIN clubs c ON c.id = cm.club_id WHERE c.academic_year = $1 ORDER BY u.login_id", [ACADEMIC_YEAR]);
  const members = await db.query<{ user_id: string; team_id: string }>("SELECT tm.user_id, tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.club_id IS NOT NULL AND tm.status = 'active'");
  return { clubs: clubs.rows, teams: teams.rows, students: students.rows, members: members.rows };
}

export async function getStudentActivities(userId: string) {
  const db = await getDb();
  const result = await db.query<{ id: string; name: string; activity_name: string; session_id: string }>(
    `SELECT t.id, t.name, COALESCE(c.name, cl.name) AS activity_name, s.id AS session_id
     FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id
     LEFT JOIN classes c ON c.id = t.class_id LEFT JOIN clubs cl ON cl.id = t.club_id
     JOIN inquiry_sessions s ON s.team_id = t.id
     WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active' AND u.status = 'active'
     ORDER BY t.created_at, t.id`, [userId]);
  return result.rows;
}
