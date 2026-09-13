import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { assignClubStudent, leaveClub, getClubManagement, enrollClubStudent } from "@/lib/clubs";

it.each(["assign", "leave"].flatMap(action => [false, true].flatMap(oldActor => [false, true].flatMap(oldClub => [false, true].map(oldStudent => ({ action, oldActor, oldClub, oldStudent }))))))(
  "$action oldActor=$oldActor oldClub=$oldClub oldStudent=$oldStudent", async ({ action, oldActor, oldClub, oldStudent }) => {
    const db = await getDb(), key = `club_year_${action}_${oldActor}_${oldClub}_${oldStudent}`, actor = `${key}_actor`, student = `${key}_student`;
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 담당',$1,$2,'teacher','unused',FALSE),($3,'합성 학생',$3,$4,'student','unused',FALSE)", [actor, ACADEMIC_YEAR - Number(oldActor), student, ACADEMIC_YEAR - Number(oldStudent)]);
    await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 동아리',$3)", [key, ACADEMIC_YEAR - Number(oldClub), actor]);
    await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,$2)", [key, actor]);
    await db.query("INSERT INTO club_members(club_id,user_id) VALUES($1,$2)", [key, student]);
    await db.query("INSERT INTO teams(id,club_id,team_number,name,leader_user_id) VALUES($1,$1,1,'합성 팀',$2)", [key, action === "leave" ? student : null]);
    if (action === "leave") await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, student]);
    const read = async () => ({ user: (await db.query("SELECT * FROM users WHERE id=$1", [student])).rows, club: (await db.query("SELECT * FROM club_members WHERE club_id=$1", [key])).rows, team: (await db.query("SELECT * FROM teams WHERE id=$1", [key])).rows, members: (await db.query("SELECT * FROM team_members WHERE team_id=$1", [key])).rows });
    const before = await read(), work = action === "assign" ? assignClubStudent(actor, key, student, key, true) : leaveClub(actor, key, student);
    if (oldActor || oldClub || oldStudent) {
      await expect(work).rejects.toThrow();
      expect(await read()).toEqual(before);
    } else {
      await work;
      const after = await read();
      expect(after.user).toEqual(before.user);
      expect(after.members[0].status).toBe(action === "assign" ? "active" : "inactive");
      expect(after.team[0].leader_user_id).toBe(action === "assign" ? student : null);
      expect(after.club[0].status).toBe(action === "assign" ? "active" : "inactive");
    }
  },
);

it.each([false, true])("management roster isolates student years for master=$master", async master => {
  const db = await getDb(), key = `club_roster_year_${master}`, actor = `${key}_actor`;
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 담당',$1,$2,'teacher','unused',FALSE,$3)", [actor, ACADEMIC_YEAR, master]);
  await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 동아리',$3)", [key, ACADEMIC_YEAR, actor]);
  await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,$2)", [key, actor]);
  await db.query("INSERT INTO teams(id,club_id,team_number,name) VALUES($1,$1,1,'합성 팀')", [key]);
  for (const old of [false, true]) {
    const id = `${key}_${old}`;
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash) VALUES($1,'합성 학생',$1,$2,'student','unused')", [id, ACADEMIC_YEAR - Number(old)]);
    await db.query("INSERT INTO club_members(club_id,user_id) VALUES($1,$2)", [key, id]);
    await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
  }
  const before = (await db.query("SELECT * FROM team_members WHERE team_id=$1 ORDER BY id", [key])).rows;
  const data = await getClubManagement(actor);
  expect(data.students.filter(row => row.club_id === key).map(row => row.id)).toEqual([`${key}_false`]);
  expect(data.members.filter(row => row.team_id === key).map(row => row.user_id)).toEqual([`${key}_false`]);
  expect((await db.query("SELECT * FROM team_members WHERE team_id=$1 ORDER BY id", [key])).rows).toEqual(before);
});

it("enrollment uses the current account when the same login exists in two years", async () => {
  const db = await getDb(), key = "club_enroll_year";
  await db.query("UPDATE users SET must_change_password=FALSE WHERE id='teacher_bootstrap'");
  await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 등록','teacher_bootstrap')", [key, ACADEMIC_YEAR]);
  await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
  for (const old of [false, true]) await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash) VALUES($1,'합성 등록 학생','29998',$2,'student','unused')", [`${key}_${old}`, ACADEMIC_YEAR - Number(old)]);
  const before = (await db.query("SELECT * FROM users WHERE login_id='29998' ORDER BY academic_year")).rows;
  const result = await enrollClubStudent("teacher_bootstrap", key, "29998", "");
  expect(result.studentId).toBe(`${key}_false`);
  expect(result.temporaryPassword).toBeNull();
  expect((await db.query("SELECT user_id FROM club_members WHERE club_id=$1", [key])).rows).toEqual([{ user_id: `${key}_false` }]);
  expect((await db.query("SELECT * FROM users WHERE login_id='29998' ORDER BY academic_year")).rows).toEqual(before);
});
