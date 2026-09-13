// Actual local services and PostgreSQL; all accounts, documents and AI results are synthetic.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("decision_final");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis, saveCycleDecision } = await import("../src/lib/cycle-analysis.ts");

const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const generate = async () => ({ model: "synthetic", result: { overview: "합성 검증", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "측정 기록", rationale: "자료 비교", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격 비교", safetyNote: "", questionForStudents: "어떤 조건인가요?" }] } });
const results = [];
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
let gate;
const connect = app.connect.bind(app);
app.connect = (...args) => args.length ? connect(...args) : (async () => {
  const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
  client.query = async (...queryArgs) => {
    const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0].text;
    if (gate && !gate.used && gate.match(sql)) {
      const selected = gate; selected.used = true; selected.pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      selected.reached(); await selected.pause;
    }
    return query(...queryArgs);
  };
  client.release = (...releaseArgs) => { client.query = query; client.release = release; return release(...releaseArgs); };
  return client;
})();
async function waitBlocked(blocker) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [blocker])).rows.length) return true;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("No database lock wait observed");
}
try {
  for (const operation of ["create", "update"]) for (const phase of ["decision_first", "final_first", "generating"]) {
    const key = `${operation}_${phase}`, team = `team_${key}`, session = `session_${key}`, plan = `plan_${key}`, report = `report_${key}`;
    await app.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',$2,'합성 최종 분석팀')", [team, 1700 + results.length]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [plan, session, cycle, { topic: "합성 원문", method: "원래 방법" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [report, session, cycle, { title: "합성 원문", result: "원래 결과" }]);
    const intermediate = await requestCycleAnalysis(cycle, "intermediate", "teacher_bootstrap", generate);
    const input = { analysisId: intermediate.id, suggestionId: intermediate.result.suggestions[0].id, decision: "modified", reason: "분석과 동시에 저장한 판단", expectedVersion: null, studentId: "demo_student_1" };
    if (operation === "update") input.expectedVersion = (await saveCycleDecision({ ...input, decision: "accepted", reason: "분석 전 원래 판단" })).version;
    const readDecisions = async () => (await app.query("SELECT * FROM cycle_ai_decisions WHERE analysis_id=$1 ORDER BY id", [intermediate.id])).rows;
    const original = await readDecisions();
    const originalPlan = (await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows;
    const originalReport = (await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows;
    const source = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    let reached, resume, captured, calls = 0;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => phase === "generating" ? false : phase === "decision_first" ? sql.includes("SELECT id, decision, reason, write_version FROM cycle_ai_decisions") : sql.includes("INSERT INTO cycle_ai_analyses") };
    const save = () => saveCycleDecision(input);
    const analyze = () => requestCycleAnalysis(cycle, "final", "teacher_bootstrap", async ({ snapshot }) => {
      captured = structuredClone(snapshot); calls++;
      if (phase === "generating" && gate && !gate.used) { gate.used = true; reached(); await pause; }
      return generate();
    });
    const first = settle(phase === "decision_first" ? save() : analyze());
    let second, waited = false;
    const timer = setTimeout(resume, 20000);
    try {
      await Promise.race([ready, first.then(result => { throw result.error ?? new Error("First action ended before pause"); })]);
      second = settle(phase === "decision_first" ? analyze() : save());
      if (phase === "generating") assert.equal((await second).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), second.then(result => { throw result.error ?? new Error("Second action did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const one = await first, two = await second; gate = null;
    const analyzed = phase === "decision_first" ? two : one, saved = phase === "decision_first" ? one : two;
    assert.equal(analyzed.ok, true, analyzed.error?.message);
    assert.equal(saved.ok, phase !== "final_first", saved.error?.message);
    const current = await readDecisions();
    if (phase === "final_first") assert.deepEqual(current, original);
    else { assert.equal(current.length, 1); assert.equal(current[0].reason, input.reason); assert.equal(Number(current[0].write_version), operation === "create" ? 1 : 2); }
    const included = captured.trajectoryContext.find(row => row.cycleId === cycle).decisions;
    const expectedReason = phase === "decision_first" ? input.reason : operation === "update" ? "분석 전 원래 판단" : null;
    assert.deepEqual(included.map(row => row.reason), expectedReason ? [expectedReason] : []);
    assert.equal(analyzed.value.isCurrent, phase !== "generating");
    const firstFinalRows = (await app.query("SELECT * FROM cycle_ai_analyses WHERE id=$1", [analyzed.value.id])).rows;
    const firstFinalSnapshot = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE id=$1", [analyzed.value.snapshotId])).rows;
    if (phase === "generating") {
      await assert.rejects(transitionCycle({ cycleId: cycle, action: "finish_project", teacherId: "teacher_bootstrap" }), /다시 분석/);
      assert.equal((await app.query("SELECT status FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0].status, "active");
      const refreshed = await analyze();
      assert.notEqual(refreshed.id, analyzed.value.id); assert.equal(refreshed.isCurrent, true);
      assert.deepEqual(captured.trajectoryContext.find(row => row.cycleId === cycle).decisions.map(row => row.reason), [input.reason]);
      assert.equal(calls, 2);
    } else assert.equal(calls, 1);
    await transitionCycle({ cycleId: cycle, action: "finish_project", teacherId: "teacher_bootstrap" });
    assert.equal((await app.query("SELECT status FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0].status, "completed");
    await assert.rejects(save(), /진행 중|최종 분석|읽기 전용/);
    assert.deepEqual(await readDecisions(), current);
    assert.deepEqual((await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows, originalPlan);
    assert.deepEqual((await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows, originalReport);
    for (const snapshot of source) assert.deepEqual((await app.query("SELECT * FROM cycle_evidence_snapshots WHERE id=$1", [snapshot.id])).rows[0], snapshot);
    assert.deepEqual((await app.query("SELECT * FROM cycle_ai_analyses WHERE id=$1", [analyzed.value.id])).rows, firstFinalRows);
    assert.deepEqual((await app.query("SELECT * FROM cycle_evidence_snapshots WHERE id=$1", [analyzed.value.snapshotId])).rows, firstFinalSnapshot);
    results.push({ operation, phase, observedLockWait: waited, decisionSaved: saved.ok, firstFinalCurrent: analyzed.value.isCurrent, reanalysisRequired: phase === "generating", sourcePreserved: true, completed: true });
    console.log(`${key}: passed`);
  }
  await writeFile(new URL("postgres-decision-final-race.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
