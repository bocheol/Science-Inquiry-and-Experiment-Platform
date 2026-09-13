// Disposable PostgreSQL, real material/cycle services, injected analysis only.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("material_practice");
globalThis.fetch = async () => { throw new Error("External network forbidden"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { saveAndSyncMaterials, retryMaterialSync } = await import("../src/lib/materials.ts");
const { requestCycleAnalysis, getCycleJourney } = await import("../src/lib/cycle-analysis.ts");
const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const { getInquiryDataForTeam } = await import("../src/lib/inquiry-data.ts");
const results = [], items = [{ name: "합성 비커", specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "" }];
const generate = async () => ({ model: "synthetic", result: { overview: "합성 검토", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "조건 확인", rationale: "자료 확인", evidenceIds: ["plan:topic"], feasibleNextStep: "간격 비교", safetyNote: "", questionForStudents: "기준은?" }] } });
try {
  await app.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
  for (const action of ["start_next", "finish_project"]) for (const mode of ["practice", "standard", "uncertain", "mixed"]) {
    const key = `${action}_${mode}`, team = `team_${key}`, session = `session_${key}`;
    await app.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',$2,'합성 준비물 검증팀')", [team, 700 + results.length]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$2,'REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')", [session, cycle, { topic: "합성 측정" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,status) VALUES($1,$1,$2,'reviewed')", [session, cycle]);
    if (mode === "practice" || mode === "mixed") {
      const saved = await saveAndSyncMaterials({ submissionId: `practice_${key}`, sessionId: session, cycleId: cycle, teamId: team, actorId: "demo_student_1", items });
      assert.equal(saved.syncStatus, "pending");
      const request = (await app.query("SELECT * FROM material_requests WHERE submission_id=$1", [`practice_${key}`])).rows[0];
      assert.equal(request.sync_snapshot, null); assert.equal(request.synced_at, null);
      assert.equal((await retryMaterialSync(request.id, "teacher_bootstrap")).syncStatus, "pending");
      assert.deepEqual((await app.query("SELECT * FROM material_requests WHERE id=$1", [request.id])).rows[0], request);
      assert.equal((await getInquiryDataForTeam(team)).materials.isPractice, true);
    }
    if (mode !== "practice") await app.query(
      "INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,sync_snapshot) VALUES($1,$1,$2,$3,$4,$5,$6,$7)",
      [`blocked_${key}`, session, cycle, team, mode === "uncertain" ? "demo_student_1" : "demo_student_2", JSON.stringify(items), mode === "uncertain" ? JSON.stringify({ spreadsheetId: "synthetic-unknown-target" }) : null],
    );
    const before = (await app.query("SELECT * FROM material_requests WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    await requestCycleAnalysis(cycle, action === "start_next" ? "intermediate" : "final", "teacher_bootstrap", generate);
    if (mode === "practice") {
      await transitionCycle({ cycleId: cycle, action, teacherId: "teacher_bootstrap" });
      const archived = (await getCycleJourney(session)).find(row => row.id === cycle);
      assert.equal(archived.status, "completed");
      assert.equal(archived.analysis.documents.materialRequests[0].isPractice, true);
      assert.equal(archived.analysis.documents.materialRequests[0].syncStatus, "pending");
    } else {
      await assert.rejects(transitionCycle({ cycleId: cycle, action, teacherId: "teacher_bootstrap" }), /준비물.*전송/);
      assert.equal((await app.query("SELECT status FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0].status, "active");
    }
    assert.deepEqual((await app.query("SELECT * FROM material_requests WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, before);
    assert.equal((await app.query("SELECT * FROM material_sheet_dispatch")).rows.length, 0);
    results.push({ action, mode, transitionAllowed: mode === "practice", originalRequestPreserved: true, falselyMarkedSynced: false });
    console.log(`${key}: passed`);
  }
  await writeFile(new URL("postgres-material-practice.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
