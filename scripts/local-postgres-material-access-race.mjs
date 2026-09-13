// Isolated local PostgreSQL and actual services; the loader blocks real Sheet transport.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("material_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { saveAndSyncMaterials } = await import("../src/lib/materials.ts");
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { removeStudent, assignStudent, archiveTeam } = await import("../src/lib/teams.ts");
const { deactivateStudent } = await import("../src/lib/student-management.ts");
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
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [blocker])).rows.length) return true;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("No database lock wait observed");
}
try {
  for (const scenario of ["remove", "move", "deactivate", "archive"]) for (const first of reproduce ? ["change"] : ["change", "save"]) {
    const key = `${scenario}_${first}`, actor = `actor_${key}`, team = `team_${key}`, other = `other_${key}`, session = `session_${key}`;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 준비물 학생',$1,2026,'student','class_2026_9','unused',FALSE)", [actor]);
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 준비물팀',$3),($4,'class_2026_9',$5,'합성 이동팀',NULL)", [team, 500 + results.length * 2, actor, other, 501 + results.length * 2]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$2)", [session, team]);
    const cycleId = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`member_${key}`, team, actor]);
    const items = [{ name: `합성 원문 ${key}`, specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "" }];
    let sends = 0, prepares = 0;
    globalThis.__syntheticSheetPrepare = async (snapshot, operationId) => { prepares++; return { requests: [], receiptId: operationId, sheetName: snapshot.sheetName, rowCount: 1 }; };
    globalThis.__syntheticSheetTransfer = async () => { sends++; return { rowCount: 1 }; };
    const change = () => scenario === "remove" ? removeStudent("teacher_bootstrap", actor, team) : scenario === "move" ? assignStudent("teacher_bootstrap", actor, other) : scenario === "deactivate" ? deactivateStudent("teacher_bootstrap", actor) : archiveTeam("teacher_bootstrap", team, "9반 합성 준비물팀");
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => first === "change" ? sql.includes("SELECT id FROM inquiry_sessions") && sql.includes("FOR UPDATE") : sql.includes("INSERT INTO material_requests") };
    const writing = settle(saveAndSyncMaterials({ submissionId: key, sessionId: session, teamId: team, cycleId, actorId: actor, items }));
    let changing, waited = false;
    const timer = setTimeout(resume, 15000);
    try {
      await Promise.race([ready, writing.then(result => { throw result.error ?? new Error("Save ended before pause"); })]);
      changing = settle(change());
      if (first === "change") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(result => { throw result.error ?? new Error("Change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const written = await writing, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const allowed = reproduce || first === "save";
    assert.equal(written.ok, allowed, written.error?.message);
    const rows = (await app.query("SELECT submitted_by,form_data,sync_status FROM material_requests WHERE submission_id=$1", [key])).rows;
    assert.deepEqual(rows, allowed ? [{ submitted_by: actor, form_data: items, sync_status: "synced" }] : []);
    assert.equal(sends, allowed ? 1 : 0); assert.equal(prepares, allowed ? 1 : 0);
    assert.equal((await app.query("SELECT * FROM material_sheet_dispatch")).rows.length, 0);
    const membership = (await app.query("SELECT status,left_at FROM team_members WHERE id=$1", [`member_${key}`])).rows[0];
    assert.equal(membership.status, scenario === "archive" ? "active" : "inactive");
    if (scenario !== "archive") assert.ok(membership.left_at);
    results.push({ scenario, first, reproduced: reproduce, saved: written.ok, prepares, sends, observedLockWait: waited, membershipHistoryPreserved: true });
    console.log(`${key}: ${reproduce ? "unauthorized save reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-material-access-before.json" : "postgres-material-access-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
