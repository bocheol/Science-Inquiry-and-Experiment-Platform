import { hash } from "bcryptjs";
import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { authenticateForSession, createSessionToken, getSessionUserFromToken } from "@/lib/auth";
import { getTeacherDashboardData } from "@/lib/teacher-data";
import { ACADEMIC_YEAR } from "@/lib/constants";

it.each(["student", "teacher", "master"])("keeps duplicate yearly %s logins separate and rejects an old-year token", async role => {
  const db = await getDb(), login = `year_scope_${role}`, password = "synthetic-year-password", passwordHash = await hash(password, 4);
  for (const year of [ACADEMIC_YEAR - 1, ACADEMIC_YEAR]) await db.query(
    "INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 학년도 계정',$2,$3,$4,$5,FALSE,$6)",
    [`${login}_${year}`, login, year, role === "student" ? "student" : "teacher", passwordHash, role === "master"],
  );
  const current = await authenticateForSession(login, password);
  expect(current?.userId).toBe(`${login}_${ACADEMIC_YEAR}`);
  expect((await getSessionUserFromToken(await createSessionToken(current!)))?.id).toBe(current!.userId);
  const previous = await authenticateForSession(login, password, ACADEMIC_YEAR - 1);
  expect(previous?.userId).toBe(`${login}_${ACADEMIC_YEAR - 1}`);
  await expect(getSessionUserFromToken(await createSessionToken(previous!))).resolves.toBeNull();
  expect((await db.query("SELECT id FROM users WHERE login_id=$1", [login])).rows).toHaveLength(2);
});

it("shows the current year's active and archived class records without changing older records", async () => {
  const db = await getDb();
  for (const year of [ACADEMIC_YEAR - 1, ACADEMIC_YEAR]) {
    const classroom = `year_scope_class_${year}`;
    await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,41,'합성 학년도 반')", [classroom, year]);
    for (const state of ["active", "inactive"]) await db.query(
      "INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password,status) VALUES($1,'합성 명단',$1,$2,'student',$3,'unused',FALSE,$4)",
      [`year_scope_student_${year}_${state}`, year, classroom, state],
    );
    for (const state of ["active", "archived"]) await db.query(
      "INSERT INTO teams(id,class_id,team_number,name,status) VALUES($1,$2,$3,'합성 연도팀',$4)",
      [`year_scope_team_${year}_${state}`, classroom, state === "active" ? 1 : 2, state],
    );
    await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`year_scope_member_${year}`, `year_scope_team_${year}_active`, `year_scope_student_${year}_active`]);
  }
  const oldYear = ACADEMIC_YEAR - 1;
  // Historical/inconsistent cross-year memberships must not leak into the
  // current roster or member count, and must remain untouched by a read.
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES('year_cross_old_team',$1,$2),('year_cross_old_user',$3,$4)",
    [`year_scope_team_${oldYear}_active`, `year_scope_student_${ACADEMIC_YEAR}_active`, `year_scope_team_${ACADEMIC_YEAR}_active`, `year_scope_student_${oldYear}_active`]);
  const memberships = (await db.query("SELECT * FROM team_members WHERE id IN ('year_cross_old_team','year_cross_old_user') ORDER BY id")).rows;
  const oldUsers = (await db.query("SELECT * FROM users WHERE class_id=$1 ORDER BY id", [`year_scope_class_${oldYear}`])).rows;
  const oldTeams = (await db.query("SELECT * FROM teams WHERE class_id=$1 ORDER BY id", [`year_scope_class_${oldYear}`])).rows;
  const data = await getTeacherDashboardData();
  expect(data.students.filter(row => row.id === `year_scope_student_${ACADEMIC_YEAR}_active`)).toHaveLength(1);
  expect(data.students.find(row => row.id === `year_scope_student_${ACADEMIC_YEAR}_active`)?.teamId).toBe(`year_scope_team_${ACADEMIC_YEAR}_active`);
  expect(data.teams.find(row => row.id === `year_scope_team_${ACADEMIC_YEAR}_active`)?.memberCount).toBe(1);
  for (const [rows, suffix, prefix] of [[data.students, "active", "student"], [data.inactiveStudents, "inactive", "student"], [data.teams, "active", "team"], [data.archivedTeams, "archived", "team"]] as const) {
    expect(rows.some(row => row.id === `year_scope_${prefix}_${ACADEMIC_YEAR}_${suffix}`)).toBe(true);
    expect(rows.some(row => row.id === `year_scope_${prefix}_${oldYear}_${suffix}`)).toBe(false);
  }
  expect((await db.query("SELECT * FROM users WHERE class_id=$1 ORDER BY id", [`year_scope_class_${oldYear}`])).rows).toEqual(oldUsers);
  expect((await db.query("SELECT * FROM teams WHERE class_id=$1 ORDER BY id", [`year_scope_class_${oldYear}`])).rows).toEqual(oldTeams);
  expect((await db.query("SELECT * FROM team_members WHERE id IN ('year_cross_old_team','year_cross_old_user') ORDER BY id")).rows).toEqual(memberships);
});
