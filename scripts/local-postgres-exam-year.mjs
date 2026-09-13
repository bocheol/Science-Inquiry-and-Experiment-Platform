import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("exam_year");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { deleteExamQuestionSlot } = await import("../src/lib/exam-service.ts");
const results = [];
try {
  // Verify PostgreSQL's inferred numeric type as well as the explicitly typed production query.
  assert.equal((await app.query("SELECT 2::integer - $1 AS score", [1])).rows[0].score, 1);
  for (const club of [false, true]) for (const old of [false, true]) {
    const key = `exam_delete_${club}_${old}`, year = 2026 - Number(old);
    if (club) {
      await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 시험 동아리','teacher_bootstrap')", [key, year]);
      await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
    } else await app.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,201,'합성 학급')", [key, year]);
    await app.query("INSERT INTO exam_sets(id,class_id,club_id,title,common_count,team_count,individual_count,total_score,created_by) VALUES($1,$2,$3,'합성 시험',2,0,0,2,'teacher_bootstrap')", [key, club ? null : key, club ? key : null]);
    for (const sequence of [1, 2]) await app.query("INSERT INTO exam_questions(id,exam_set_id,scope,sequence,question,competency,max_score,model_answer) VALUES($1,$2,'common',$3,'합성 문제','해석',1,'합성 답')", [`${key}_${sequence}`, key, sequence]);
    const read = async () => ({ set: (await app.query("SELECT * FROM exam_sets WHERE id=$1", [key])).rows[0], questions: (await app.query("SELECT * FROM exam_questions WHERE exam_set_id=$1 ORDER BY id", [key])).rows });
    const before = await read();
    if (old) {
      await assert.rejects(deleteExamQuestionSlot("teacher_bootstrap", `${key}_1`), /시험을 찾을 수 없습니다/);
      assert.deepEqual(await read(), before);
    } else {
      await deleteExamQuestionSlot("teacher_bootstrap", `${key}_1`);
      const after = await read();
      assert.equal(after.set.common_count, 1); assert.equal(after.set.total_score, 1);
      assert.equal(after.questions.length, 1); assert.equal(after.questions[0].sequence, 1);
      assert.equal(after.questions[0].question, before.questions[1].question);
    }
    results.push({ club, oldYear: old, passed: true });
    console.log(`${key}: passed`);
  }
  await writeFile(new URL("postgres-exam-year-43.json", root), JSON.stringify({ database, postgresVersion, inferredIntegerArithmetic: true, results }, null, 2));
} finally { await app.end(); }
