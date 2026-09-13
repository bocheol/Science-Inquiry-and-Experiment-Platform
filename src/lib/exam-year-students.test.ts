import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { generateExamSet, getPublishedStudentExamResult } from "@/lib/exam-service";
import type { ExamGenerator } from "@/lib/exam-ai";

async function activity(key: string, club: boolean, year: number, number: number) {
  const db = await getDb();
  if (club) await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 시험 동아리','teacher_bootstrap')", [key, year]);
  else await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'합성 시험 학급')", [key, year, number]);
}
const cases = [false, true].flatMap(club => [false, true].flatMap(oldStudent => [false, true].flatMap(oldTeam => [false, true].map(oldExam => ({ club, oldStudent, oldTeam, oldExam }))))).map((item, index) => ({ ...item, index }));
it.each(cases)("result club=$club oldStudent=$oldStudent oldTeam=$oldTeam oldExam=$oldExam", async ({ club, oldStudent, oldTeam, oldExam, index }) => {
  const db = await getDb(), key = `exam_result_year_${index}`, scope = `${key}_scope`;
  await activity(key, club, ACADEMIC_YEAR - Number(oldTeam), 501 + index * 2);
  await activity(scope, club, ACADEMIC_YEAR - Number(oldExam), 502 + index * 2);
  const examScope = oldTeam === oldExam ? key : scope;
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 수험생',$1,$2,'student','unused',FALSE)", [key, ACADEMIC_YEAR - Number(oldStudent)]);
  await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,1,'합성 시험팀')", [key, club ? null : key, club ? key : null]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$1)", [key]);
  await db.query("INSERT INTO exam_sets(id,class_id,club_id,title,status,common_count,team_count,individual_count,total_score,created_by) VALUES($1,$2,$3,'합성 결과','confirmed',1,0,0,1,'teacher_bootstrap')", [key, club ? null : examScope, club ? examScope : null]);
  await db.query("INSERT INTO exam_questions(id,exam_set_id,scope,sequence,question,competency,max_score,model_answer) VALUES($1,$1,'common',1,'합성 문제','해석',1,'합성 답')", [key]);
  await db.query("INSERT INTO exams(id,exam_set_id,session_id,student_id,status) VALUES($1,$1,$1,$1,'published')", [key]);
  await db.query("INSERT INTO exam_results(id,exam_id,total_score,published_at) VALUES($1,$1,1,CURRENT_TIMESTAMP)", [key]);
  const read = async () => ({ results: (await db.query("SELECT * FROM exam_results WHERE id=$1", [key])).rows, members: (await db.query("SELECT * FROM team_members WHERE id=$1", [key])).rows });
  const before = await read();
  for (const selected of [undefined, key]) {
    const result = await getPublishedStudentExamResult(key, selected);
    if (oldStudent || oldTeam || oldExam) expect(result).toBeNull();
    else expect(result).toMatchObject({ title: "합성 결과", totalScore: 1, maxScore: 1 });
  }
  expect(await read()).toEqual(before);
});

it.each([false, true])("generation excludes historical accounts club=%s", async club => {
  const db = await getDb(), key = `exam_generation_year_${club}`;
  if (club) {
    await activity(key, true, ACADEMIC_YEAR, 0);
    await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
    await db.query("INSERT INTO club_config_versions(id,club_id,config_type,version_number,title,status,created_by) VALUES($1,$1,'exam',1,'합성 설정','published','teacher_bootstrap')", [key]);
  }
  const classId = (await db.query("SELECT id FROM classes WHERE academic_year=$1 AND class_number=6", [ACADEMIC_YEAR])).rows[0].id;
  await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,1,'합성 시험팀')", [key, club ? null : classId, club ? key : null]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
  for (const old of [false, true]) {
    const id = `${key}_${old}`;
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash) VALUES($1,'합성 수험생',$1,$2,'student','unused')", [id, ACADEMIC_YEAR - Number(old)]);
    await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
  }
  const before = (await db.query("SELECT * FROM team_members WHERE team_id=$1 ORDER BY id", [key])).rows;
  const generator: ExamGenerator = {
    generateCommon: async () => [{ stimulus: "합성 자료", question: "합성 문제", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }],
    generateTeam: async () => ({ teamQuestions: [], individualQuestions: [] }),
  };
  const id = await generateExamSet("teacher_bootstrap", { ...(club ? { clubId: key } : { classNumber: 6 }), title: "합성 시험", commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 공통 범위" }, generator);
  expect((await db.query("SELECT student_id FROM exams WHERE exam_set_id=$1 ORDER BY student_id", [id])).rows).toEqual([{ student_id: `${key}_false` }]);
  expect((await db.query("SELECT * FROM team_members WHERE team_id=$1 ORDER BY id", [key])).rows).toEqual(before);
});
