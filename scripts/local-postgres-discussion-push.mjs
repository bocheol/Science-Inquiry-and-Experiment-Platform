import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("discussion_push");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { saveDiscussionEntry } = await import("../src/lib/discussions.ts");
const { deliverDiscussionPush } = await import("../src/lib/discussion-push.ts");
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { removeStudent } = await import("../src/lib/teams.ts");
const { runDatabaseMigrations } = await import("../src/lib/db/migrations.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let gate;
const query = app.query.bind(app);
app.query = async (...args) => {
  if (gate && !gate.used && gate.matches(String(args[0]))) {
    const current = gate; current.used = true; current.ready.resolve(); await current.resume.promise;
  }
  return query(...args);
};
const results = [];
try {
  const migration = (await app.query("SELECT * FROM schema_migrations WHERE version='0011'")).rows;
  assert.equal(migration.length, 1);
  await runDatabaseMigrations(app);
  assert.deepEqual((await app.query("SELECT * FROM schema_migrations WHERE version='0011'")).rows, migration);
  for (const club of [false, true]) for (const scenario of ["concurrent", "takeover_before", "takeover_after", "rebound", "remove", "renewed_expired", "retry", "attempt_limit", "age_limit"]) {
    const key = `push_${club}_${scenario}`, sender = `${key}_a`, reader = `${key}_b`;
    for (const id of [sender, reader]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 계정',$1,2026,'student','unused',FALSE)", [id]);
    if (club) await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')", [key]);
    await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 알림팀')", [key, club ? null : "class_2026_4", club ? key : null, 160 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
    for (const id of [sender, reader]) await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
    const cycle = await ensureInitialCycle(app, key, "teacher_bootstrap");
    await app.query("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES($1,$2,$3,'synthetic-key','synthetic-auth')", [key, reader, `https://push.example/${key}`]);
    const input = { id: key, sessionId: key, cycleId: cycle, kind: "peer", content: "발송하지 않을 합성 비공개 원문" };
    await saveDiscussionEntry({ id: sender, role: "student", mustChangePassword: false }, input);
    const source = (await app.query("SELECT * FROM discussion_entries WHERE id=$1", [key])).rows;
    const readJob = async () => (await app.query("SELECT * FROM discussion_push_outbox WHERE entry_id=$1", [key])).rows[0];
    const ready = deferred(), resume = deferred(), calls = [];
    const fake = async (_subscription, payload) => {
      calls.push(JSON.parse(payload));
      if (["concurrent", "takeover_after", "renewed_expired"].includes(scenario) && calls.length === 1) { ready.resolve(); await resume.promise; }
      if ((scenario === "takeover_after" || scenario === "retry") && calls.length === 1) throw Object.assign(new Error("Synthetic unavailable"), { statusCode: 503 });
      if (scenario === "renewed_expired") throw Object.assign(new Error("Synthetic old subscription expired"), { statusCode: 410 });
    };
    if (scenario === "attempt_limit") await app.query("UPDATE discussion_push_outbox SET attempts=5 WHERE entry_id=$1", [key]);
    if (scenario === "age_limit") await app.query("UPDATE discussion_push_outbox SET created_at=$2 WHERE entry_id=$1", [key, new Date(Date.now() - 2 * 86400000)]);
    if (scenario === "takeover_before") gate = { ready, resume, matches: sql => sql.startsWith("SELECT entry_id FROM discussion_push_outbox WHERE") };
    if (scenario === "rebound" || scenario === "remove") {
      let reads = 0;
      gate = { ready, resume, matches: sql => sql.startsWith("SELECT ps.id,ps.user_id") && ++reads === 2 };
    }
    const first = deliverDiscussionPush(key, fake);
    if (["concurrent", "takeover_before", "takeover_after", "rebound", "remove", "renewed_expired"].includes(scenario)) {
      await ready.promise;
      if (scenario === "concurrent") assert.deepEqual(await deliverDiscussionPush(key, fake), { attempted: 0, sent: 0 });
      if (scenario.startsWith("takeover")) {
        const oldToken = (await readJob()).lease_token;
        await app.query("UPDATE discussion_push_outbox SET lease_until=$2 WHERE entry_id=$1", [key, new Date(Date.now() - 1000)]);
        assert.deepEqual(await deliverDiscussionPush(key, fake), { attempted: 1, sent: 1 });
        assert.notEqual((await readJob()).lease_token, oldToken);
      }
      if (scenario === "rebound") await app.query("UPDATE push_subscriptions SET user_id=$2 WHERE id=$1", [key, sender]);
      if (scenario === "remove") await removeStudent("teacher_bootstrap", reader, key);
      if (scenario === "renewed_expired") await app.query("UPDATE push_subscriptions SET p256dh='new-synthetic-key' WHERE id=$1", [key]);
      resume.resolve();
    }
    await first; gate = null;
    if (scenario === "retry") {
      assert.equal((await readJob()).status, "pending");
      assert.deepEqual(await deliverDiscussionPush(key, fake), { attempted: 0, sent: 0 });
      await app.query("UPDATE discussion_push_outbox SET next_attempt_at=$2 WHERE entry_id=$1", [key, new Date(Date.now() - 1000)]);
      assert.deepEqual(await deliverDiscussionPush(key, fake), { attempted: 1, sent: 1 });
    }
    const job = await readJob();
    assert.equal(job.status, ["rebound", "remove", "renewed_expired", "attempt_limit", "age_limit"].includes(scenario) ? "skipped" : "sent");
    const expectedCalls = ["takeover_after", "retry"].includes(scenario) ? 2 : ["rebound", "remove", "attempt_limit", "age_limit"].includes(scenario) ? 0 : 1;
    assert.equal(calls.length, expectedCalls);
    assert.equal(job.lease_token, null);
    assert.deepEqual(await deliverDiscussionPush(key, fake), { attempted: 0, sent: 0 });
    assert.deepEqual(await readJob(), job);
    const subscription = (await app.query("SELECT user_id,p256dh FROM push_subscriptions WHERE id=$1", [key])).rows[0];
    assert.ok(subscription);
    if (scenario === "renewed_expired") assert.equal(subscription.p256dh, "new-synthetic-key");
    for (const payload of calls) { assert.equal(payload.body, "팀에 새 메시지가 도착했습니다. 앱에서 확인하세요."); assert.equal(payload.url, "/inquiry"); assert.equal(payload.tag, `discussion-${key}`); }
    assert.deepEqual((await app.query("SELECT * FROM discussion_entries WHERE id=$1", [key])).rows, source);
    results.push({ club, scenario, calls: calls.length, status: job.status, attempts: job.attempts, sourcePreserved: true, subscriptionPreserved: true });
  }
  await writeFile(new URL("postgres-discussion-push-59.json", root), JSON.stringify({ database, postgresVersion, migrationReplayPreserved: true, results }, null, 2));
  console.log(JSON.stringify({ passed: results.length }));
} finally { gate?.resume.resolve(); await app.end(); }
