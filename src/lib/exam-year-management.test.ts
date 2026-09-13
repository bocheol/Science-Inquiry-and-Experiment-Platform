import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { addCommonExamQuestion, updateExamQuestion, deleteExamQuestionSlot, confirmExamSet, createCorrectionExamSet, saveExamResult, publishExamResult, getExamSetForPdf } from "@/lib/exam-service";

const input = { stimulus: "합성 자료", question: "합성 문항 수정", competency: "해석", difficulty: "standard" as const, modelAnswer: "합성 답", scoringRubric: [{ criterion: "근거", points: 1 }] };
async function fixture(key: string, year: number, club: boolean, classNumber: number) {
  const db = await getDb();
  if (club) {
    await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 시험 동아리','teacher_bootstrap')", [key, year]);
    await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
  } else await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'합성 시험 학급')", [key, year, classNumber]);
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 수험생',$1,$2,'student',$3,'unused',FALSE)", [key, year, club ? null : key]);
  await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,1,'합성 시험팀')", [key, club ? null : key, club ? key : null]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$1)", [key]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
  await db.query("INSERT INTO exam_sets(id,class_id,club_id,title,common_count,team_count,individual_count,total_score,created_by) VALUES($1,$2,$3,'합성 시험',3,0,0,3,'teacher_bootstrap')", [key, club ? null : key, club ? key : null]);
  for (const sequence of [1, 2, 3]) await db.query("INSERT INTO exam_questions(id,exam_set_id,scope,sequence,question,competency,max_score,model_answer,scoring_rubric) VALUES($1,$2,'common',$3,'원래 합성 문항','해석',1,'합성 답',$4)", [`${key}_${sequence}`, key, sequence, JSON.stringify(input.scoringRubric)]);
  await db.query("INSERT INTO exams(id,exam_set_id,session_id,student_id,status) VALUES($1,$1,$1,$1,'graded')", [key]);
  await db.query("INSERT INTO exam_results(id,exam_id,total_score,graded_by) VALUES($1,$1,1,'teacher_bootstrap')", [key]);
}

it.each(["update", "delete", "add", "confirm", "correction", "grade", "publish", "pdf"].flatMap((action, index) => [false, true].flatMap(club => [false, true].map(old => ({ action, index, club, old })))))(
  "$action club=$club oldYear=$old targets exactly the requested current exam", async ({ action, index, club, old }) => {
    const db = await getDb(), key = `exam_year_${action}_${club}_${old}`, fallback = `${key}_fallback`, number = 201 + index * 2 + Number(old);
    await fixture(key, ACADEMIC_YEAR - Number(old), club, number);
    if (old && !club) await fixture(fallback, ACADEMIC_YEAR, false, number);
    if (["correction", "grade", "publish", "pdf"].includes(action)) await db.query("UPDATE exam_sets SET status='confirmed' WHERE id=$1", [key]);
    if (action === "pdf" && old && !club) await db.query("UPDATE exam_sets SET status='confirmed' WHERE id=$1", [fallback]);
    const read = async () => ({
      sets: (await db.query("SELECT * FROM exam_sets WHERE id=$1 OR id=$2 OR parent_exam_set_id=$1 ORDER BY id", [key, fallback])).rows,
      questions: (await db.query("SELECT * FROM exam_questions WHERE exam_set_id=$1 OR exam_set_id=$2 ORDER BY id", [key, fallback])).rows,
      exams: (await db.query("SELECT * FROM exams WHERE exam_set_id=$1 OR exam_set_id=$2 ORDER BY id", [key, fallback])).rows,
      results: (await db.query("SELECT * FROM exam_results WHERE exam_id=$1 OR exam_id=$2 ORDER BY id", [key, fallback])).rows,
      sessions: (await db.query("SELECT * FROM inquiry_sessions WHERE id=$1 OR id=$2 ORDER BY id", [key, fallback])).rows,
    });
    const before = await read();
    const work = action === "update" ? updateExamQuestion("teacher_bootstrap", { ...input, questionId: `${key}_1` })
      : action === "delete" ? deleteExamQuestionSlot("teacher_bootstrap", `${key}_1`)
      : action === "add" ? addCommonExamQuestion("teacher_bootstrap", { ...input, examSetId: key, maxScore: 1 })
      : action === "confirm" ? confirmExamSet("teacher_bootstrap", key)
      : action === "correction" ? createCorrectionExamSet("teacher_bootstrap", key, "합성 교정 이유")
      : action === "grade" ? saveExamResult("teacher_bootstrap", { examId: key, questionScores: { [`${key}_1`]: 1, [`${key}_2`]: 0, [`${key}_3`]: 0 }, teacherFeedback: "합성 채점" })
      : action === "publish" ? publishExamResult("teacher_bootstrap", key)
      : getExamSetForPdf(key, undefined, "teacher_bootstrap");
    if (old) {
      await expect(work).rejects.toThrow();
      expect(await read()).toEqual(before);
    } else {
      const value = await work;
      const after = await read();
      if (action === "update") expect(after.questions[0].question).toBe(input.question);
      if (action === "delete") expect(after.questions).toHaveLength(2);
      if (action === "add") expect(after.questions).toHaveLength(4);
      if (action === "confirm") expect(after.sets[0].status).toBe("confirmed");
      if (action === "correction") { expect(after.sets).toHaveLength(2); expect(after.sets.find(row => row.id === key)).toEqual(before.sets[0]); }
      if (action === "grade") expect(after.results[0].teacher_feedback).toBe("합성 채점");
      if (action === "publish") expect(after.exams[0].status).toBe("published");
      if (action === "pdf") { expect(value).toMatchObject({ id: key }); expect(after).toEqual(before); }
    }
  },
);
