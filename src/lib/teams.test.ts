import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { getInquiryDataForUser } from "@/lib/inquiry-data";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { archiveTeam, restoreTeam } from "@/lib/teams";

const teamId = "archive_test_team";
const studentId = "archive_test_student";

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
     VALUES ($1, '보관 시험 학생', '10697', 2026, 'student', 'class_2026_6', 'unused', FALSE)`,
    [studentId],
  );
  await db.query(
    "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_6', 97, '보관시험조', $2)",
    [teamId, studentId],
  );
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ('archive_test_member', $1, $2)", [teamId, studentId]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ('archive_test_session', $1, 'PLANNING')", [teamId]);
  await db.query("INSERT INTO investigation_plans (id, session_id) VALUES ('archive_test_plan', 'archive_test_session')");
  await db.query("INSERT INTO messages (id, session_id, role, content, sequence) VALUES ('archive_test_message', 'archive_test_session', 'user', '보존할 질문', 1)");
});

describe("teacher team archive and restore", () => {
  it("requires the exact confirmation and preserves every team record", async () => {
    await expect(archiveTeam("teacher_bootstrap", teamId, "보관시험조")).rejects.toThrow("확인 문구");
    await archiveTeam("teacher_bootstrap", teamId, "6반 보관시험조");

    const dashboard = await getTeacherDashboardData();
    expect(dashboard.teams.some((team) => team.id === teamId)).toBe(false);
    expect(dashboard.archivedTeams.find((team) => team.id === teamId)).toMatchObject({ memberCount: 1, classNumber: 6 });
    expect(await getInquiryDataForUser(studentId)).toBeNull();

    const db = await getDb();
    expect(Number((await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM team_members WHERE team_id = $1", [teamId])).rows[0]?.count)).toBe(1);
    expect(Number((await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM messages WHERE session_id = 'archive_test_session'")).rows[0]?.count)).toBe(1);

    await restoreTeam("teacher_bootstrap", teamId);
    expect((await getTeacherDashboardData()).teams.some((team) => team.id === teamId)).toBe(true);
    expect((await getInquiryDataForUser(studentId))?.team.id).toBe(teamId);
  });
});
