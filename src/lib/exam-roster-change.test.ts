import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { generateExamSet } from "@/lib/exam-service";
import { removeStudent, assignStudent, archiveTeam, createTeam } from "@/lib/teams";
import { deactivateStudent } from "@/lib/student-management";
import type { ExamGenerator } from "@/lib/exam-ai";

it.each(["unchanged", "remove", "deactivate", "move", "add", "archive", "empty_add", "new_add"])("exam generation rechecks its roster after %s", async action => {
  const db = await getDb(), key = `exam_roster_${action}`, student = `${key}_student`, added = `${key}_added`, target = `${key}_target`;
  const classId = (await db.query("SELECT id FROM classes WHERE academic_year=$1 AND class_number=5", [ACADEMIC_YEAR])).rows[0].id;
  for (const id of [student, added]) await db.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 수험생',$1,$2,'student',$3,'unused',FALSE)", [id, ACADEMIC_YEAR, classId]);
  for (const id of [key, target]) {
    await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,$2,$3,'합성 시험팀')", [id, classId, (["unchanged", "remove", "deactivate", "move", "add", "archive", "empty_add", "new_add"].indexOf(action) * 2) + (id === key ? 1 : 2)]);
    await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [id]);
  }
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, student]);
  let changed = false; let createdTeam: string | undefined;
  const generator: ExamGenerator = {
    generateCommon: async () => [{ stimulus: "합성 자료", question: "합성 문제", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }],
    generateTeam: async () => {
      if (!changed) {
        changed = true;
        if (action === "remove") await removeStudent("teacher_bootstrap", student, key);
        if (action === "deactivate") await deactivateStudent("teacher_bootstrap", student);
        if (action === "move") await assignStudent("teacher_bootstrap", student, target);
        if (action === "add") await assignStudent("teacher_bootstrap", added, key);
        if (action === "empty_add") await assignStudent("teacher_bootstrap", added, target);
        if (action === "new_add") { createdTeam = await createTeam("teacher_bootstrap", 5, 17); await assignStudent("teacher_bootstrap", added, createdTeam); }
        if (action === "archive") await archiveTeam("teacher_bootstrap", key, "5반 합성 시험팀");
      }
      return { teamQuestions: [], individualQuestions: [] };
    },
  };
  const before = (await db.query("SELECT id FROM exam_sets ORDER BY id")).rows;
  const work = generateExamSet("teacher_bootstrap", { classNumber: 5, title: key, commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 범위" }, generator);
  if (action === "unchanged") {
    const id = await work;
    expect((await db.query("SELECT student_id FROM exams WHERE exam_set_id=$1", [id])).rows).toEqual([{ student_id: student }]);
  } else {
    await expect(work).rejects.toMatchObject({ status: 409 });
    expect((await db.query("SELECT id FROM exam_sets ORDER BY id")).rows).toEqual(before);
  }
  const rows = (await db.query("SELECT * FROM team_members WHERE user_id=$1 ORDER BY id", [student])).rows;
  expect(rows.some(row => row.team_id === key)).toBe(true);
  if (["remove", "deactivate", "move"].includes(action)) expect(rows.find(row => row.team_id === key).status).toBe("inactive");
  if (action === "move") expect(rows.some(row => row.team_id === target && row.status === "active")).toBe(true);
  // End this synthetic team's activity so later cases have only their own active roster.
  await db.query("UPDATE teams SET status='archived' WHERE id=$1 OR id=$2 OR id=$3", [key, target, createdTeam ?? null]);
});
