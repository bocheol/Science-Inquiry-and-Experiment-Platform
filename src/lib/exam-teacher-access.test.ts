import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { generateExamSet } from "@/lib/exam-service";
import { changeManagedAccountStatus } from "@/lib/master-accounts";
import { updatePassword } from "@/lib/auth";
import { setClubTeacherAssignment } from "@/lib/club-settings";
import type { ExamGenerator } from "@/lib/exam-ai";

const cases = [...[false, true].flatMap(club => (club ? ["deactivate", "password", "unassign"] : ["deactivate", "password"]).flatMap(action => ["start", "generating", "cached"].map(phase => ({ club, action, phase })))), ...["generating", "cached"].map(phase => ({ club: true, action: "master_unassign", phase }))].map((item, index) => ({ ...item, index }));
it.each(cases)("teacher access club=$club action=$action phase=$phase", async ({ club, action, phase, index }) => {
  const db = await getDb(), key = `exam_teacher_${index}`, teacher = `${key}_teacher`, master = `${key}_master`, student = `${key}_student`;
  for (const [id, role, isMaster] of [[teacher, "teacher", action === "master_unassign"], [master, "teacher", true], [student, "student", false]] as const) await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 계정',$1,$2,$3,'unused',FALSE,$4)", [id, ACADEMIC_YEAR, role, isMaster]);
  if (club) {
    await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 동아리',$3)", [key, ACADEMIC_YEAR, teacher]);
    await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,$2)", [key, teacher]);
    await db.query("INSERT INTO club_config_versions(id,club_id,config_type,version_number,title,status,created_by) VALUES($1,$1,'exam',1,'합성 설정','published',$2)", [key, teacher]);
  }
  const classId = (await db.query("SELECT id FROM classes WHERE academic_year=$1 AND class_number=4", [ACADEMIC_YEAR])).rows[0].id;
  await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 시험팀')", [key, club ? null : classId, club ? key : null, 100 + index]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, student]);
  const change = () => action === "deactivate" ? changeManagedAccountStatus(master, teacher, "deactivate") : action === "password" ? updatePassword(teacher, "synthetic-reset-only", true) : setClubTeacherAssignment(master, key, teacher, false);
  let calls = 0, changed = false;
  const generator: ExamGenerator = {
    generateCommon: async () => { calls++; return [{ stimulus: "합성 자료", question: "합성 문제", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }]; },
    generateTeam: async () => { if (phase === "generating" && !changed) { changed = true; await change(); } return { teamQuestions: [], individualQuestions: [] }; },
  };
  const input = { ...(club ? { clubId: key } : { classNumber: 4 }), title: key, commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 범위" };
  const read = async () => ({ sets: (await db.query("SELECT * FROM exam_sets WHERE title=$1", [key])).rows, papers: (await db.query("SELECT * FROM exams WHERE student_id=$1 ORDER BY id", [student])).rows });
  if (phase === "cached") await generateExamSet(teacher, input, generator);
  const before = await read();
  if (phase !== "generating") await change();
  if (action === "master_unassign") {
    const id = await generateExamSet(teacher, input, generator);
    expect((await read()).sets[0].id).toBe(id);
    if (phase === "cached") expect(await read()).toEqual(before);
  } else {
    await expect(generateExamSet(teacher, input, generator)).rejects.toMatchObject({ status: 403 });
    expect(await read()).toEqual(before);
  }
  expect(calls).toBe(phase === "start" ? 0 : 1);
  expect((await db.query("SELECT status FROM team_members WHERE id=$1", [key])).rows[0].status).toBe("active");
  await db.query("UPDATE teams SET status='archived' WHERE id=$1", [key]);
});
