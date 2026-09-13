// Reproduction probe: success means the documented defect is present, not fixed.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root } = await createLocalTestDb("plan_review_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestStudentPlanAiReview } = await import("../src/lib/plan-ai-review.ts");
const results = [];
try {
  for (const change of ["account_inactive", "membership_removed"]) {
    const key = `probe_${change}`;
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 재현 팀','demo_student_1')", [key, results.length + 80]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,'demo_student_1')", [key]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'PLANNING')", [key]);
    const cycle = await ensureInitialCycle(app, key, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data) VALUES($1,$1,$2,$3)", [key, cycle, JSON.stringify({ field: "화학", topic: "합성 주제", motivation: "관찰", purpose: "비교", method: "측정", expectedResult: "차이" })]);
    const review = await requestStudentPlanAiReview(key, "demo_student_1", async () => {
      if (change === "account_inactive") await app.query("UPDATE users SET status='inactive' WHERE id='demo_student_1'");
      else await app.query("UPDATE team_members SET status='inactive', left_at=CURRENT_TIMESTAMP WHERE id=$1", [key]);
      return { model: "synthetic-no-network", result: { readiness: "needs_revision", summary: "합성 응답", strengths: [], checks: [], limitations: [] } };
    });
    const stored = (await app.query("SELECT id FROM plan_ai_reviews WHERE id=$1", [review.id])).rowCount;
    assert.equal(stored, 1);
    await assert.rejects(requestStudentPlanAiReview(key, "demo_student_1"));
    results.push({ change, lateResultReturned: true, lateResultStored: true, nextRequestDenied: true });
    await app.query("UPDATE users SET status='active' WHERE id='demo_student_1'");
  }
  await writeFile(new URL("plan-review-late-access-76.json", root), JSON.stringify({ defectReproduced: true, syntheticOnly: true, results }, null, 2));
  console.log(JSON.stringify({ defectReproduced: true, cases: results.length }));
} finally { await app.end(); }
