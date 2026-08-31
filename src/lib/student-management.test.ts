import { describe, expect, it } from "vitest";
import { authenticate } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { addStudent, deactivateStudent, parseStudentLoginId, restoreStudent } from "@/lib/student-management";
import { assignStudent } from "@/lib/teams";

describe("teacher student account management", () => {
  it("validates the five-digit student login format", () => {
    expect(parseStudentLoginId("10898")).toMatchObject({ classNumber: 8, studentNumber: 98 });
    expect(() => parseStudentLoginId("10800")).toThrow("5자리");
    expect(() => parseStudentLoginId("20801")).toThrow("5자리");
  });

  it("adds, deactivates, preserves, and restores a student account", async () => {
    const credential = await addStudent("teacher_bootstrap", { loginId: "10898", name: "계정관리시험학생" });
    const db = await getDb();
    const student = await db.query<{ id: string }>("SELECT id FROM users WHERE login_id = $1", [credential.loginId]);
    const studentId = student.rows[0]!.id;
    expect(await authenticate(credential.loginId, credential.temporaryPassword)).toBe(studentId);
    await expect(addStudent("teacher_bootstrap", { loginId: credential.loginId, name: "중복학생" })).rejects.toThrow("이미 등록");

    await db.query(
      "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ('student_management_team', 'class_2026_8', 98, '계정관리시험조', $1)",
      [studentId],
    );
    await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('student_management_session', 'student_management_team')");
    await db.query(
      "INSERT INTO team_members (id, team_id, user_id) VALUES ('student_management_member', 'student_management_team', $1)",
      [studentId],
    );
    await db.query(
      `INSERT INTO messages (id, session_id, sender_id, sender_alias, role, content, sequence)
       VALUES ('student_management_message', 'student_management_session', $1, '팀원 A', 'user', '보존할 시험 기록', 1)`,
      [studentId],
    );

    await deactivateStudent("teacher_bootstrap", studentId);
    expect(await authenticate(credential.loginId, credential.temporaryPassword)).toBeNull();
    await expect(assignStudent("teacher_bootstrap", studentId, "student_management_team")).rejects.toThrow("활성 학생");
    const inactiveState = await db.query<{ user_status: string; member_status: string; leader_user_id: string | null }>(
      `SELECT u.status AS user_status, tm.status AS member_status, t.leader_user_id
         FROM users u
         JOIN team_members tm ON tm.user_id = u.id
         JOIN teams t ON t.id = tm.team_id
        WHERE u.id = $1`,
      [studentId],
    );
    expect(inactiveState.rows[0]).toMatchObject({
      user_status: "inactive",
      member_status: "inactive",
      leader_user_id: null,
    });
    const preservedMessages = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM messages WHERE sender_id = $1", [studentId]);
    expect(preservedMessages.rows[0]?.count).toBe("1");
    const inactiveDashboard = await getTeacherDashboardData();
    expect(inactiveDashboard.students.some((item) => item.id === studentId)).toBe(false);
    expect(inactiveDashboard.inactiveStudents.some((item) => item.id === studentId)).toBe(true);
    await expect(addStudent("teacher_bootstrap", { loginId: credential.loginId, name: "계정관리시험학생" })).rejects.toThrow("복원");

    await restoreStudent("teacher_bootstrap", studentId);
    expect(await authenticate(credential.loginId, credential.temporaryPassword)).toBe(studentId);
    const restoredDashboard = await getTeacherDashboardData();
    expect(restoredDashboard.inactiveStudents.some((item) => item.id === studentId)).toBe(false);
    expect(restoredDashboard.students.find((item) => item.id === studentId)?.teamId).toBeNull();
  });
});
