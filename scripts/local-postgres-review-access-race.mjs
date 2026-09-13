// Actual local services; isolated synthetic accounts/documents and no push subscriptions.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("review_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { reviewPlan } = await import("../src/lib/plan-service.ts");
const { reviewReport } = await import("../src/lib/report-service.ts");
const { archiveTeam } = await import("../src/lib/teams.ts");
const { changeManagedAccountStatus, resetManagedAccountPassword } = await import("../src/lib/master-accounts.ts");
const { setClubTeacherAssignment } = await import("../src/lib/club-settings.ts");
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
  for (const document of ["plan", "report"]) for (const scenario of document === "plan" ? ["deactivate", "password", "archive", "unassign"] : ["deactivate", "password", "archive"]) for (const feedback of [false, true]) for (const first of reproduce ? ["change"] : ["change", "review"]) {
    const key = `${document}_${scenario}_${feedback ? "feedback" : "approve"}_${first}`, teacher = `teacher_${key}`, team = `team_${key}`, session = `session_${key}`, doc = `doc_${key}`, club = `club_${key}`;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 검토 교사',$1,2026,'teacher','unused',FALSE)", [teacher]);
    if (scenario === "unassign") {
      await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')", [club]);
      await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')", [club, teacher]);
    }
    await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 검토팀')", [team, scenario === "unassign" ? null : "class_2026_9", scenario === "unassign" ? club : null, 900 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$2)", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    if (document === "plan") await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'pending')", [doc, session, cycle, { topic: "합성 원문", method: "원래 방법" }]);
    else await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'submitted')", [doc, session, cycle, { title: "합성 원문", analysis: "원래 결과" }]);
    const table = document === "plan" ? "investigation_plans" : "reports";
    const original = (await app.query(`SELECT * FROM ${table} WHERE id=$1`, [doc])).rows[0];
    const review = () => document === "plan" ? reviewPlan(doc, teacher, feedback ? "feedback" : "approved", feedback ? "합성 수정 요청" : "", "", { cycleId: cycle, submissionId: null, status: "pending", feedback: "" })
      : reviewReport(doc, teacher, feedback ? "feedback" : "reviewed", feedback ? "합성 수정 요청" : "", { cycleId: cycle, version: 0, status: "submitted", feedback: "" });
    const change = () => scenario === "deactivate" ? changeManagedAccountStatus("teacher_bootstrap", teacher, "deactivate")
      : scenario === "password" ? resetManagedAccountPassword("teacher_bootstrap", teacher).then(() => undefined)
      : scenario === "archive" ? archiveTeam("teacher_bootstrap", team, "9반 합성 검토팀")
      : setClubTeacherAssignment("teacher_bootstrap", club, teacher, false);
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => reproduce || first === "review" ? sql.includes(`UPDATE ${table}`) : sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE") };
    const reviewing = settle(review());
    let changing, waited = false;
    const timer = setTimeout(resume, 20000);
    try {
      await Promise.race([ready, reviewing.then(result => { throw result.error ?? new Error("Review ended before pause"); })]);
      changing = settle(change());
      if (first === "change") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(result => { throw result.error ?? new Error("Access change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const reviewed = await reviewing, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const allowed = reproduce || first === "review";
    assert.equal(reviewed.ok, allowed, reviewed.error?.message);
    const current = (await app.query(`SELECT * FROM ${table} WHERE id=$1`, [doc])).rows[0];
    if (!allowed) assert.deepEqual(current, original);
    else {
      assert.deepEqual(current.form_data, original.form_data);
      assert.equal(current[document === "plan" ? "review_status" : "status"], feedback ? "feedback" : document === "plan" ? "approved" : "reviewed");
      assert.equal(current.reviewed_by, teacher);
    }
    const history = (await app.query("SELECT * FROM document_revisions WHERE document_id=$1 ORDER BY id", [doc])).rows;
    assert.equal(history.length, allowed ? 1 : 0);
    const notices = (await app.query("SELECT content FROM notices WHERE source_id=$1 AND kind='action_request'", [doc])).rows;
    assert.deepEqual(notices, allowed && feedback ? [{ content: "합성 수정 요청" }] : []);
    if (!reproduce) {
      await assert.rejects(review(), /권한|활성|보관/);
      assert.deepEqual((await app.query(`SELECT * FROM ${table} WHERE id=$1`, [doc])).rows[0], current);
      assert.deepEqual((await app.query("SELECT * FROM document_revisions WHERE document_id=$1 ORDER BY id", [doc])).rows, history);
    }
    results.push({ document, scenario, feedback, first, reproduced: reproduce, reviewed: reviewed.ok, observedLockWait: waited, originalContentPreserved: true, revisionCount: history.length, noticeCount: notices.length });
    console.log(`${key}: ${reproduce ? "revoked access write reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-review-access-before.json" : "postgres-review-access-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
