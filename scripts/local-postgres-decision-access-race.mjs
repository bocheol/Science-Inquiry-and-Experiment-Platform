// Actual local services and PostgreSQL; all accounts, documents and AI results are synthetic.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("decision_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis, saveCycleDecision } = await import("../src/lib/cycle-analysis.ts");

const { archiveTeam, removeStudent, assignStudent } = await import("../src/lib/teams.ts");
const { deactivateStudent } = await import("../src/lib/student-management.ts");
const { updatePassword } = await import("../src/lib/auth.ts");
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
  for (const operation of ["create", "update", "replay"]) for (const scenario of ["deactivate", "password", "archive", "remove", "move"]) for (const first of reproduce ? ["change"] : ["change", "save"]) {
    const key = `${operation}_${scenario}_${first}`, actor = `actor_${key}`, peer = `peer_${key}`, team = `team_${key}`, other = `other_${key}`, session = `session_${key}`, plan = `plan_${key}`, report = `report_${key}`;
    for (const id of [actor, peer]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 판단 참여자',$1,2026,'student','class_2026_9','unused',FALSE)", [id]);
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 판단팀',$3),($4,'class_2026_9',$5,'합성 이동팀',NULL)", [team, 1500 + results.length * 2, peer, other, 1501 + results.length * 2]);
    for (const id of [actor, peer]) await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`member_${id}`, team, id]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [plan, session, cycle, { topic: "합성 원문", method: "원래 방법" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [report, session, cycle, { title: "합성 원문", result: "원래 결과" }]);
    const analysis = await requestCycleAnalysis(cycle, "intermediate", "teacher_bootstrap", generate);
    const input = { analysisId: analysis.id, suggestionId: analysis.result.suggestions[0].id, decision: "accepted", reason: "합성 원래 판단", expectedVersion: null, studentId: actor };
    if (operation !== "create") {
      const seeded = await saveCycleDecision({ ...input, studentId: peer });
      input.expectedVersion = seeded.version;
      if (operation === "update") { input.decision = "modified"; input.reason = "합성 수정 판단"; }
    }
    const readDecision = async () => (await app.query("SELECT * FROM cycle_ai_decisions WHERE analysis_id=$1 ORDER BY id", [analysis.id])).rows;
    const original = await readDecision();
    const source = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    const originalAnalysis = (await app.query("SELECT * FROM cycle_ai_analyses WHERE id=$1", [analysis.id])).rows;
    const save = () => saveCycleDecision(input);
    const change = () => scenario === "password" ? updatePassword(actor, "synthetic-reset-only", true)
      : scenario === "deactivate" ? deactivateStudent("teacher_bootstrap", actor)
      : scenario === "remove" ? removeStudent("teacher_bootstrap", actor, team)
      : scenario === "move" ? assignStudent("teacher_bootstrap", actor, other)
      : archiveTeam("teacher_bootstrap", team, "9반 합성 판단팀");
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => reproduce || first === "save" ? sql.includes("SELECT id, decision, reason, write_version FROM cycle_ai_decisions") : sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE") };
    const saving = settle(save());
    let changing, waited = false;
    const timer = setTimeout(resume, 20000);
    try {
      await Promise.race([ready, saving.then(result => { throw result.error ?? new Error("Decision ended before pause"); })]);
      changing = settle(change());
      if (first === "change") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(result => { throw result.error ?? new Error("Access change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const saved = await saving, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const allowed = reproduce || first === "save";
    assert.equal(saved.ok, allowed, saved.error?.message);
    const current = await readDecision();
    if (!allowed || operation === "replay") assert.deepEqual(current, original);
    else {
      assert.equal(current.length, 1); assert.equal(current[0].reason, input.reason); assert.equal(current[0].decision, input.decision);
      assert.equal(current[0].created_by, operation === "create" ? actor : peer); assert.equal(current[0].updated_by, actor);
      assert.equal(Number(current[0].write_version), operation === "create" ? 1 : Number(original[0].write_version) + 1);
    }
    assert.deepEqual((await app.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, source);
    assert.deepEqual((await app.query("SELECT * FROM cycle_ai_analyses WHERE id=$1", [analysis.id])).rows, originalAnalysis);
    if (!reproduce) { await assert.rejects(save(), /권한|활성/); assert.deepEqual(await readDecision(), current); }
    results.push({ operation, scenario, first, reproduced: reproduce, saved: saved.ok, observedLockWait: waited, sourcePreserved: true, originalAuthorPreserved: true });
    console.log(`${key}: ${reproduce ? "revoked access decision reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-decision-access-before.json" : "postgres-decision-access-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
