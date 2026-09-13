import { expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "teacher_bootstrap", role: "teacher", mustChangePassword: false }) }));
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { POST as manageTeam } from "@/app/api/teacher/teams/route";
import { PATCH as manageStudent } from "@/app/api/teacher/students/route";

const operations = ["assign", "remove", "leader", "archive", "restore", "deactivate_student", "restore_student", "archive_club", "restore_club"];
it.each(operations.flatMap((operation, index) => [false, true].map(old => ({ operation, index, old }))))(
  "$operation oldYear=$old keeps management changes in the current year", async ({ operation, index, old }) => {
    const db = await getDb(), key = `management_year_${operation}_${old}`, student = `${key}_student`, team = `${key}_team`, activity = `${key}_activity`;
    const year = ACADEMIC_YEAR - Number(old), club = operation.endsWith("_club"), restore = operation.startsWith("restore");
    if (club) await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 관리 동아리','teacher_bootstrap')", [activity, year]);
    else await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'합성 관리 학급')", [activity, year, 80 + index]);
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password,status) VALUES($1,'합성 관리 학생',$1,$2,'student',$3,'unused',FALSE,$4)", [student, year, club ? null : activity, operation === "restore_student" ? "inactive" : "active"]);
    await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name,status) VALUES($1,$2,$3,1,'합성 관리팀',$4)", [team, club ? null : activity, club ? activity : null, restore && operation !== "restore_student" ? "archived" : "active"]);
    if (operation !== "assign") await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [key, team, student]);
    const historicalTeam = `${key}_historical_team`;
    if (!old && (operation === "assign" || operation === "deactivate_student")) {
      await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'과거 합성 학급')", [`${key}_historical_class`, year - 1, 100 + index]);
      await db.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,$2,1,'과거 합성 팀',$3)", [historicalTeam, `${key}_historical_class`, student]);
      await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`${key}_historical_member`, historicalTeam, student]);
    }
    const read = async () => ({
      users: (await db.query("SELECT * FROM users WHERE id=$1", [student])).rows,
      teams: (await db.query("SELECT * FROM teams WHERE id=$1", [team])).rows,
      members: (await db.query("SELECT * FROM team_members WHERE team_id=$1 ORDER BY id", [team])).rows,
      sessions: (await db.query("SELECT * FROM inquiry_sessions WHERE team_id=$1", [team])).rows,
      historicalTeam: (await db.query("SELECT * FROM teams WHERE id=$1", [historicalTeam])).rows,
      historicalMembers: (await db.query("SELECT * FROM team_members WHERE team_id=$1 ORDER BY id", [historicalTeam])).rows,
    });
    const before = await read();
    const studentAction = operation.endsWith("_student");
    const action = operation.replace("_student", "").replace("_club", "");
    const response = await (studentAction ? manageStudent : manageTeam)(new Request("http://localhost/api/teacher/synthetic", {
      method: studentAction ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, studentId: student, teamId: team, asLeader: true, confirmation: `${club ? "합성 관리 동아리" : `${80 + index}반`} 합성 관리팀` }),
    }));
    expect.soft(response.status).toBe(old ? 400 : 200);
    const after = await read();
    if (old) expect(after).toEqual(before);
    else {
      expect(after.historicalTeam).toEqual(before.historicalTeam);
      expect(after.historicalMembers).toEqual(before.historicalMembers);
      if (action === "assign" || action === "leader") expect(after.teams[0].leader_user_id).toBe(student);
      if (action === "assign") expect(after.members).toHaveLength(1);
      if (action === "remove") expect(after.members[0].status).toBe("inactive");
      if (action === "archive") expect(after.teams[0].status).toBe("archived");
      if (action === "restore" && !studentAction) expect(after.teams[0].status).toBe("active");
      if (studentAction) expect(after.users[0].status).toBe(action === "deactivate" ? "inactive" : "active");
    }
  },
);
