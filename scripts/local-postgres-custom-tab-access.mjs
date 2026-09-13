// Synthetic local database only; inspect actual lock waits and historical rows.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, postgresVersion } = await createLocalTestDb("custom_tab_access");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { createClub, createClubTeam, leaveClub } = await import("../src/lib/clubs.ts");
const { createClubConfigDraft, publishClubConfig } = await import("../src/lib/club-settings.ts");
const { saveCustomTabResponse } = await import("../src/lib/club-custom-tabs.ts");
const { archiveTeam } = await import("../src/lib/teams.ts");
const { updatePassword } = await import("../src/lib/auth.ts");
const results = [], settle = promise => promise.then(value => ({ ok: true, value }), () => ({ ok: false }));
let gate;
const connect = app.connect.bind(app);
app.connect = (...args) => args.length ? connect(...args) : (async () => {
  const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
  client.query = async (...queryArgs) => {
    const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0].text;
    if (gate && !gate.used && gate.match(sql)) {
      const selected = gate; selected.used = true;
      selected.pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      selected.reached(); await selected.pause;
    }
    return query(...queryArgs);
  };
  client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
  return client;
})();
async function waitBlocked(blocker) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [blocker])).rows.length) return true;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Expected database lock wait was absent");
}
try {
  for (const changeType of ["leave", "deactivate", "password", "archive"]) for (const first of ["change", "save"]) {
    const key = `custom_${changeType}_${first}`, title = `합성 추가 탭 ${key}`, actor = `student_${key}`;
    const club = await createClub("teacher_bootstrap", title);
    const configVersionId = await createClubConfigDraft("teacher_bootstrap", { clubId: club, configType: "custom_tab" });
    await publishClubConfig("teacher_bootstrap", configVersionId, title);
    const team = await createClubTeam("teacher_bootstrap", club, "합성 팀");
    const sessionId = (await app.query("SELECT id FROM inquiry_sessions WHERE team_id=$1", [team])).rows[0].id;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 작성자',$1,2026,'student','unused',FALSE)", [actor]);
    await app.query("INSERT INTO club_members(club_id,user_id) VALUES($1,$2)", [club, actor]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [key, team, actor]);
    const membership = (await app.query("SELECT * FROM team_members WHERE id=$1", [key])).rows[0];
    const change = () => changeType === "leave" ? leaveClub("teacher_bootstrap", club, actor)
      : changeType === "deactivate" ? app.query("UPDATE users SET status='inactive',session_version=session_version+1 WHERE id=$1", [actor])
      : changeType === "password" ? updatePassword(actor, "synthetic-reset-only-76", true)
      : archiveTeam("teacher_bootstrap", team, `${title} 합성 팀`);
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => first === "change"
      ? sql.includes("SELECT team_id FROM inquiry_sessions") && sql.includes("FOR UPDATE")
      : sql.includes("INSERT INTO club_custom_responses") };
    const writing = settle(saveCustomTabResponse(actor, { sessionId, configVersionId, responseData: {}, submit: false, expectedVersion: null }));
    let changing, waited = false;
    const timer = setTimeout(resume, 15000);
    try {
      await Promise.race([ready, writing.then(() => { throw new Error("Write completed before gate"); })]);
      changing = settle(change());
      if (first === "change") assert.equal((await changing).ok, true);
      else waited = await Promise.race([waitBlocked(gate.pid), changing.then(() => { throw new Error("Change did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const written = await writing; assert.equal((await changing).ok, true); gate = null;
    assert.equal(written.ok, first === "save");
    const rows = (await app.query("SELECT * FROM club_custom_responses WHERE session_id=$1", [sessionId])).rows;
    assert.equal(rows.length, first === "save" ? 1 : 0);
    if (rows.length) assert.equal(rows[0].submitted_by, actor);
    const history = (await app.query("SELECT * FROM team_members WHERE id=$1", [key])).rows[0];
    assert.equal(history.user_id, membership.user_id); assert.equal(history.joined_at.getTime(), membership.joined_at.getTime());
    assert.equal(history.status, changeType === "leave" ? "inactive" : "active");
    assert.equal((await settle(saveCustomTabResponse(actor, { sessionId, configVersionId, responseData: {}, submit: false, expectedVersion: 1 }))).ok, false);
    assert.deepEqual((await app.query("SELECT * FROM club_custom_responses WHERE session_id=$1", [sessionId])).rows, rows);
    const audits = (await app.query("SELECT id FROM audit_logs WHERE actor_id=$1 AND action='club_custom_tab_saved'", [actor])).rows;
    assert.equal(audits.length, rows.length);
    results.push({ changeType, first, passed: true, waited, responsePreserved: true, membershipPreserved: true, auditMatches: true });
  }
  await writeFile(new URL("postgres-custom-tab-access-76.json", root), JSON.stringify({ postgresVersion, syntheticOnly: true, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, observedLockWaits: results.filter(r => r.waited).length }));
} finally { await app.end(); }
