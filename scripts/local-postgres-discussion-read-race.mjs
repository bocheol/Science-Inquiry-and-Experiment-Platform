import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("discussion_reads");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { saveDiscussionEntry, markDiscussionMessagesRead } = await import("../src/lib/discussions.ts");
const { removeStudent } = await import("../src/lib/teams.ts");
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { runDatabaseMigrations } = await import("../src/lib/db/migrations.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const connect = app.connect.bind(app);
let gate;
app.connect = (...args) => args.length ? connect(...args) : (async () => {
  const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
  client.query = async (...args) => {
    if (gate && !gate.used && gate.matches(String(args[0]))) {
      const current = gate; current.used = true; current.pid = client.processID;
      current.ready.resolve(); await current.resume.promise;
    }
    return query(...args);
  };
  client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
  return client;
})();
async function waitBlocked(pid) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if ((await app.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND $2::integer=ANY(pg_blocking_pids(pid))", [database, pid])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Expected actual PostgreSQL lock wait was not observed");
}
const results = [];
try {
  const migration = (await app.query("SELECT * FROM schema_migrations WHERE version='0010'")).rows;
  assert.equal(migration.length, 1);
  await runDatabaseMigrations(app);
  assert.deepEqual((await app.query("SELECT * FROM schema_migrations WHERE version='0010'")).rows, migration);
  for (const club of [false, true]) for (const operation of ["send", "read"]) for (const first of ["change", "save"]) {
    const key = `receipt_${club}_${operation}_${first}`, sender = `${key}_a`, reader = `${key}_b`, entry = `${key}_message`;
    for (const id of [sender, reader]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 계정',$1,2026,'student','unused',FALSE)", [id]);
    if (club) await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')", [key]);
    await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 대화팀')", [key, club ? null : "class_2026_4", club ? key : null, 101 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
    for (const id of [sender, reader]) await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
    const cycle = await ensureInitialCycle(app, key, "teacher_bootstrap");
    const actor = id => ({ id, role: "student", mustChangePassword: false });
    const input = { id: entry, sessionId: key, cycleId: cycle, kind: "peer", content: "합성 경합 메시지" };
    if (operation === "read") await saveDiscussionEntry(actor(sender), input);
    const sourceBefore = (await app.query("SELECT * FROM discussion_entries WHERE id=$1", [entry])).rows;
    gate = { ready: deferred(), resume: deferred(), matches: first === "change" ? sql => sql.startsWith("SELECT id FROM users WHERE id = $1 FOR UPDATE") : operation === "send" ? sql => sql.startsWith("INSERT INTO discussion_entries") : sql => sql.startsWith("UPDATE discussion_message_recipients SET read_at") };
    const current = gate;
    const saving = settle(operation === "send" ? saveDiscussionEntry(actor(sender), input) : markDiscussionMessagesRead(actor(reader), key, cycle, [entry]));
    await current.ready.promise;
    const changing = settle(removeStudent("teacher_bootstrap", reader, key));
    if (first === "change") assert.equal((await changing).ok, true);
    else await waitBlocked(current.pid);
    current.resume.resolve();
    const result = await saving, change = await changing;
    gate = null;
    assert.equal(change.ok, true, change.error?.message);
    assert.equal(result.ok, operation === "send" || first === "save", result.error?.message);
    if (!result.ok) assert.equal(result.error.status, 403);
    const recipients = (await app.query("SELECT * FROM discussion_message_recipients WHERE entry_id=$1", [entry])).rows;
    assert.equal(recipients.length, operation === "send" && first === "change" ? 0 : 1);
    if (recipients.length) {
      assert.equal(recipients[0].membership_id, reader);
      assert.equal(Boolean(recipients[0].read_at), operation === "read" && first === "save");
    }
    const oldMember = (await app.query("SELECT * FROM team_members WHERE id=$1", [reader])).rows;
    assert.equal(oldMember[0].status, "inactive"); assert.ok(oldMember[0].left_at);
    // A new membership must not revive the old message's unread receipt.
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`${reader}_rejoin`, key, reader]);
    assert.deepEqual(await markDiscussionMessagesRead(actor(reader), key, cycle, [entry]), { marked: 0 });
    assert.deepEqual((await app.query("SELECT * FROM discussion_message_recipients WHERE entry_id=$1", [entry])).rows, recipients);
    assert.deepEqual((await app.query("SELECT * FROM team_members WHERE id=$1", [reader])).rows, oldMember);
    if (operation === "read") assert.deepEqual((await app.query("SELECT * FROM discussion_entries WHERE id=$1", [entry])).rows, sourceBefore);
    results.push({ club, operation, first, lockWaitObserved: first === "save", recipients: recipients.length, read: Boolean(recipients[0]?.read_at), rejoinPreserved: true });
  }
  await writeFile(new URL("postgres-discussion-read-race-57.json", root), JSON.stringify({ database, postgresVersion, migrationReplayPreserved: true, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, actualLockWaits: results.filter(row => row.lockWaitObserved).length }));
} finally { gate?.resume.resolve(); await app.end(); }
