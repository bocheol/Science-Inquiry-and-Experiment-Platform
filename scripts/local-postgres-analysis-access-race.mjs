// Actual local services and PostgreSQL; all accounts, documents and AI results are synthetic.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("analysis_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");

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
  for (const type of ["intermediate", "final"]) for (const scenario of ["deactivate", "password", "archive", "unassign"]) for (const phase of reproduce ? ["start", "generating", "result_change"] : ["start", "generating", "result_change", "result_save"]) {
    const key = `${type}_${scenario}_${phase}`, teacher = `teacher_${key}`, team = `team_${key}`, session = `session_${key}`, plan = `plan_${key}`, report = `report_${key}`, club = `club_${key}`;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 분석 교사',$1,2026,'teacher','unused',FALSE)", [teacher]);
    if (scenario === "unassign") {
      await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')", [club]);
      await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')", [club, teacher]);
    }
    await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 분석팀')", [team, scenario === "unassign" ? null : "class_2026_9", scenario === "unassign" ? club : null, 1300 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [plan, session, cycle, { topic: "합성 원문", method: "원래 방법" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [report, session, cycle, { title: "합성 원문", result: "원래 결과" }]);
    const read = async () => ({
      session: (await app.query("SELECT * FROM inquiry_sessions WHERE id=$1", [session])).rows,
      cycles: (await app.query("SELECT * FROM inquiry_cycles WHERE session_id=$1 ORDER BY ordinal", [session])).rows,
      plan: (await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows,
      report: (await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows,
    });
    const original = await read();
    const change = () => scenario === "deactivate" ? changeManagedAccountStatus("teacher_bootstrap", teacher, "deactivate")
      : scenario === "password" ? resetManagedAccountPassword("teacher_bootstrap", teacher).then(() => undefined)
      : scenario === "archive" ? archiveTeam("teacher_bootstrap", team, "9반 합성 분석팀")
      : setClubTeacherAssignment("teacher_bootstrap", club, teacher, false);
    let reached, resume, generated = false, calls = 0;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => {
      if (phase === "generating") return false;
      if (phase === "start") return reproduce ? sql.includes("INSERT INTO cycle_evidence_snapshots") : sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE");
      return reproduce || phase === "result_save" ? sql.includes("INSERT INTO cycle_ai_analyses") : generated && sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE");
    } };
    const analysis = () => requestCycleAnalysis(cycle, type, teacher, async () => {
      generated = true; calls++;
      if (phase === "generating" && gate && !gate.used) { gate.used = true; reached(); await pause; }
      return generate();
    });
    const analyzing = settle(analysis());
    let changing, waited = false;
    const timer = setTimeout(resume, 20000);
    try {
      await Promise.race([ready, analyzing.then(result => { throw result.error ?? new Error("Analysis ended before pause"); })]);
      changing = settle(change());
      if (phase !== "result_save") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(result => { throw result.error ?? new Error("Access change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const analyzed = await analyzing, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const allowed = reproduce || phase === "result_save";
    assert.equal(analyzed.ok, allowed, analyzed.error?.message);
    assert.deepEqual(await read(), original);
    const evidence = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    const analyses = (await app.query("SELECT * FROM cycle_ai_analyses WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    assert.equal(evidence.length, !reproduce && phase === "start" ? 0 : 1);
    assert.equal(calls, !reproduce && phase === "start" ? 0 : 1);
    assert.equal(analyses.length, allowed ? 1 : 0);
    const jobs = (await app.query("SELECT status FROM ai_generation_jobs WHERE created_by=$1", [teacher])).rows;
    assert.deepEqual(jobs, !reproduce && phase === "start" ? [] : [{ status: allowed ? "completed" : "failed" }]);
    if (!reproduce) {
      await assert.rejects(analysis(), /권한|활성/);
      assert.deepEqual((await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, evidence);
      assert.deepEqual((await app.query("SELECT * FROM cycle_ai_analyses WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, analyses);
      assert.deepEqual(await read(), original);
    }
    results.push({ type, scenario, phase, reproduced: reproduce, analyzed: analyzed.ok, observedLockWait: waited, generationCalls: calls, sourcePreserved: true, snapshotCount: evidence.length });
    console.log(`${key}: ${reproduce ? "revoked access analysis reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-analysis-access-before.json" : "postgres-analysis-access-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
