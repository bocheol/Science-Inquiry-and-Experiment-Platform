// Actual local services and PostgreSQL; all accounts, documents and AI results are synthetic.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("cycle_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");
const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const { archiveTeam } = await import("../src/lib/teams.ts");
const { changeManagedAccountStatus, resetManagedAccountPassword } = await import("../src/lib/master-accounts.ts");
const { setClubTeacherAssignment } = await import("../src/lib/club-settings.ts");
const generate = async () => ({ model: "synthetic", result: { overview: "합성 검증", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "측정 기록", rationale: "자료 비교", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격 비교", safetyNote: "", questionForStudents: "어떤 조건인가요?" }] } });
const reproduce = process.argv.includes("--reproduce"), results = [];
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
  await app.query("UPDATE users SET is_master=TRUE WHERE id='teacher_bootstrap'");
  for (const action of ["start_next", "finish_project"]) for (const scenario of ["deactivate", "password", "archive", "unassign"]) for (const first of reproduce ? ["change"] : ["change", "transition"]) {
    const key = `${action}_${scenario}_${first}`, teacher = `teacher_${key}`, team = `team_${key}`, session = `session_${key}`, plan = `plan_${key}`, report = `report_${key}`, club = `club_${key}`;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 회차 교사',$1,2026,'teacher','unused',FALSE)", [teacher]);
    if (scenario === "unassign") {
      await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')", [club]);
      await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')", [club, teacher]);
    }
    await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 회차팀')", [team, scenario === "unassign" ? null : "class_2026_9", scenario === "unassign" ? club : null, 1100 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [plan, session, cycle, { topic: "합성 원문", method: "원래 방법" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [report, session, cycle, { title: "합성 원문", result: "원래 결과" }]);
    await requestCycleAnalysis(cycle, action === "start_next" ? "intermediate" : "final", teacher, generate);
    const read = async () => ({
      session: (await app.query("SELECT * FROM inquiry_sessions WHERE id=$1", [session])).rows,
      cycles: (await app.query("SELECT * FROM inquiry_cycles WHERE session_id=$1 ORDER BY ordinal", [session])).rows,
      plan: (await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows,
      report: (await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows,
      revisions: (await app.query("SELECT * FROM document_revisions WHERE document_id IN ($1,$2) ORDER BY id", [plan, report])).rows,
    });
    const original = await read();
    const evidence = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    const analyses = (await app.query("SELECT * FROM cycle_ai_analyses WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    const transition = () => transitionCycle({ cycleId: cycle, action, teacherId: teacher });
    const change = () => scenario === "deactivate" ? changeManagedAccountStatus("teacher_bootstrap", teacher, "deactivate")
      : scenario === "password" ? resetManagedAccountPassword("teacher_bootstrap", teacher).then(() => undefined)
      : scenario === "archive" ? archiveTeam("teacher_bootstrap", team, "9반 합성 회차팀")
      : setClubTeacherAssignment("teacher_bootstrap", club, teacher, false);
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => reproduce || first === "transition" ? sql.includes("UPDATE inquiry_cycles SET status = 'completed'") : sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE") };
    const moving = settle(transition());
    let changing, waited = false;
    const timer = setTimeout(resume, 20000);
    try {
      await Promise.race([ready, moving.then(result => { throw result.error ?? new Error("Transition ended before pause"); })]);
      changing = settle(change());
      if (first === "change") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(result => { throw result.error ?? new Error("Access change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const moved = await moving, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const allowed = reproduce || first === "transition";
    assert.equal(moved.ok, allowed, moved.error?.message);
    const current = await read();
    if (!allowed) assert.deepEqual(current, original);
    else {
      assert.equal(current.cycles[0].status, "completed");
      assert.equal(current.cycles.length, action === "start_next" ? 2 : 1);
      assert.equal(current.session[0].stage, action === "start_next" ? "STARTING" : "COMPLETED");
      if (action === "start_next") {
        assert.deepEqual(current.plan[0].form_data, {}); assert.deepEqual(current.report[0].form_data, {});
        assert.equal(current.revisions.length, 2);
        assert.deepEqual(current.revisions.find(row => row.document_type === "plan").snapshot.formData, original.plan[0].form_data);
        assert.deepEqual(current.revisions.find(row => row.document_type === "report").snapshot.formData, original.report[0].form_data);
      } else { assert.deepEqual(current.plan, original.plan); assert.deepEqual(current.report, original.report); }
    }
    assert.deepEqual((await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, evidence);
    assert.deepEqual((await app.query("SELECT * FROM cycle_ai_analyses WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, analyses);
    if (!reproduce) { await assert.rejects(transition(), /권한|활성|종료/); assert.deepEqual(await read(), current); }
    results.push({ action, scenario, first, reproduced: reproduce, transitioned: moved.ok, observedLockWait: waited, evidencePreserved: true, analysisPreserved: true });
    console.log(`${key}: ${reproduce ? "revoked access transition reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-cycle-access-before.json" : "postgres-cycle-access-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
