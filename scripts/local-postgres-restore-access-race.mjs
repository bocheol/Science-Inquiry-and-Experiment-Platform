// Actual restore and account/team services against disposable local PostgreSQL.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("restore_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { restorePlanRevision, restoreReportRevision } = await import("../src/lib/document-history.ts");
const { archiveTeam, removeStudent, assignStudent, setTeamLeader } = await import("../src/lib/teams.ts");
const { deactivateStudent } = await import("../src/lib/student-management.ts");
const { changeManagedAccountStatus } = await import("../src/lib/master-accounts.ts");
const { updatePassword } = await import("../src/lib/auth.ts");
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
  for (const document of ["plan", "report"]) for (const scenario of ["teacher_deactivate", "teacher_password", "student_deactivate", "student_password", "remove", "move", "leader", "archive"]) for (const first of reproduce ? ["change"] : ["change", "restore"]) {
    const key = `${document}_${scenario}_${first}`, actor = `actor_${key}`, peer = `peer_${key}`, team = `team_${key}`, other = `other_${key}`, session = `session_${key}`, doc = `doc_${key}`, revision = `revision_${key}`;
    const teacher = scenario.startsWith("teacher");
    for (const [id, role] of [[actor, teacher ? "teacher" : "student"], [peer, "student"]]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 복원 참여자',$1,2026,$2,'class_2026_9','unused',FALSE)", [id, role]);
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 복원팀',$3),($4,'class_2026_9',$5,'합성 이동팀',NULL)", [team, 1100 + results.length * 2, teacher ? peer : actor, other, 1101 + results.length * 2]);
    for (const id of teacher ? [peer] : [actor, peer]) await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`member_${id}`, team, id]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic) VALUES($1,$2,'현재 주제')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    const table = document === "plan" ? "investigation_plans" : "reports";
    if (document === "plan") await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [doc, session, cycle, { topic: "현재 주제", method: "현재 방법" }]);
    else {
      await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [doc, session, cycle, { title: "현재 주제", analysis: "현재 결과" }]);
      await app.query("INSERT INTO report_member_roles(report_id,user_id,role_description) VALUES($1,$2,'현재 역할')", [doc, peer]);
    }
    const snapshot = document === "plan" ? { formData: { topic: "복원할 주제", method: "복원할 방법" }, reviewStatus: "approved", teacherFeedback: "이전 의견" }
      : { formData: { title: "복원할 주제", analysis: "복원할 결과" }, status: "reviewed", teacherFeedback: "이전 의견", roles: [{ userId: peer, description: "원래 참여자 역할" }] };
    await app.query("INSERT INTO document_revisions(id,document_type,document_id,cycle_id,snapshot,action,changed_by) VALUES($1,$2,$3,$4,$5,'synthetic_source','teacher_bootstrap')", [revision, document, doc, cycle, snapshot]);
    const original = (await app.query(`SELECT * FROM ${table} WHERE id=$1`, [doc])).rows[0];
    const source = (await app.query("SELECT * FROM document_revisions WHERE id=$1", [revision])).rows[0];
    const roles = (await app.query("SELECT * FROM report_member_roles WHERE report_id=$1 ORDER BY user_id", [doc])).rows;
    const restore = () => document === "plan" ? restorePlanRevision(doc, revision, actor, cycle) : restoreReportRevision(doc, revision, actor, cycle);
    const change = () => scenario.endsWith("password") ? updatePassword(actor, "synthetic-reset-only", true)
      : scenario === "teacher_deactivate" ? changeManagedAccountStatus("teacher_bootstrap", actor, "deactivate")
      : scenario === "student_deactivate" ? deactivateStudent("teacher_bootstrap", actor)
      : scenario === "remove" ? removeStudent("teacher_bootstrap", actor, team)
      : scenario === "move" ? assignStudent("teacher_bootstrap", actor, other)
      : scenario === "leader" ? setTeamLeader("teacher_bootstrap", team, peer)
      : archiveTeam("teacher_bootstrap", team, "9반 합성 복원팀");
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => reproduce || first === "restore" ? sql.includes("INSERT INTO document_revisions") : sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE") };
    const restoring = settle(restore());
    let changing, waited = false;
    const timer = setTimeout(resume, 20000);
    try {
      await Promise.race([ready, restoring.then(result => { throw result.error ?? new Error("Restore ended before pause"); })]);
      changing = settle(change());
      if (first === "change") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(result => { throw result.error ?? new Error("Change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const restored = await restoring, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const allowed = reproduce || first === "restore";
    assert.equal(restored.ok, allowed, restored.error?.message);
    const current = (await app.query(`SELECT * FROM ${table} WHERE id=$1`, [doc])).rows[0];
    const currentRoles = (await app.query("SELECT * FROM report_member_roles WHERE report_id=$1 ORDER BY user_id", [doc])).rows;
    if (!allowed) { assert.deepEqual(current, original); assert.deepEqual(currentRoles, roles); }
    else {
      assert.deepEqual(current.form_data, snapshot.formData);
      assert.equal(current[document === "plan" ? "review_status" : "status"], document === "plan" ? "reapproval_required" : "draft");
      assert.equal(current.teacher_feedback, null);
      if (document === "report") assert.deepEqual(currentRoles.map(row => ({ userId: row.user_id, description: row.role_description })), snapshot.roles);
    }
    assert.deepEqual((await app.query("SELECT * FROM document_revisions WHERE id=$1", [revision])).rows[0], source);
    const history = (await app.query("SELECT * FROM document_revisions WHERE document_id=$1 ORDER BY id", [doc])).rows;
    assert.equal(history.length, allowed ? 2 : 1);
    if (!reproduce) {
      await assert.rejects(restore(), /복원|권한|팀장/);
      assert.deepEqual((await app.query(`SELECT * FROM ${table} WHERE id=$1`, [doc])).rows[0], current);
      assert.deepEqual((await app.query("SELECT * FROM document_revisions WHERE document_id=$1 ORDER BY id", [doc])).rows, history);
    }
    results.push({ document, scenario, first, reproduced: reproduce, restored: restored.ok, observedLockWait: waited, sourcePreserved: true, historyCount: history.length });
    console.log(`${key}: ${reproduce ? "unauthorized restore reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-restore-access-before.json" : "postgres-restore-access-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
