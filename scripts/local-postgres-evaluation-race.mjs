// Synthetic memberships and evaluations only. Run with local-ts-loader.mjs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 20000 };
for (const key of ["DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[key] = "";
const database = `codex_validation_evaluations_${Date.now()}_${randomBytes(4).toString("hex")}`;
const admin = new pg.Pool({ ...config, database: "postgres" });
let app, observer;
const results = [], reproduce = process.argv.includes("--reproduce");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
try {
  const identity = (await admin.query("SELECT current_user AS actor, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416); assert.ok(identity.version >= 160000 && identity.version < 170000);
  assert.match(database, /^codex_validation_evaluations_[0-9]+_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE "${database}"`);
  process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(config.password)}@127.0.0.1:55416/${database}?options=-c%20statement_timeout%3D20000`;
  process.env.NODE_ENV = "test"; process.env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-evaluation-race-only";
  const { getDb } = await import("../src/lib/db/index.ts");
  const { createEvaluationRound, changeEvaluationRoundStatus, saveSelfEvaluation, savePeerEvaluation, saveEvaluationTeacherSummary, publishEvaluationRound, CORE_EVALUATION_ITEMS } = await import("../src/lib/evaluation-service.ts");
  const { removeStudent, assignStudent } = await import("../src/lib/teams.ts");
  const { deactivateStudent } = await import("../src/lib/student-management.ts");
  app = await getDb(); observer = new pg.Pool({ ...config, database });
  const roundId = await createEvaluationRound("teacher_bootstrap", { classNumber: 7, title: "합성 소속 경합", optionalItem: "none" });
  await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "open");
  const responses = CORE_EVALUATION_ITEMS.map(item => ({ itemId: item.id, value: 3, reason: "" }));
  const nativeConnect = app.connect.bind(app);
  let gate = null;
  app.connect = (...args) => args.length ? nativeConnect(...args) : (async () => {
    const client = await nativeConnect(), query = client.query.bind(client), release = client.release.bind(client);
    client.query = async (...queryArgs) => {
      if (gate && !gate.used && gate.matches(String(queryArgs[0]))) {
        const current = gate; current.used = true; current.pid = client.processID; current.ready.resolve(); await current.resume.promise;
      }
      return query(...queryArgs);
    };
    client.release = (...releaseArgs) => { client.query = query; return release(...releaseArgs); };
    return client;
  })();
  async function waitBlocked(pid) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid))", [database, pid])).rows.length) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error("Membership change did not wait for the evaluation writer");
  }
  for (const scenario of ["self_remove", "self_deactivate", "self_move", "peer_author_remove", "peer_target_remove", "peer_target_deactivate", "peer_target_move"]) {
    for (const first of reproduce ? ["membership"] : ["membership", "evaluation"]) {
      const key = `${scenario}_${first}`, author = `author_${key}`, target = `target_${key}`, team = `team_${key}`, session = `session_${key}`, other = `other_${key}`;
      for (const id of [author, target]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 학생',$1,2026,'student','class_2026_7','unused',FALSE)", [id]);
      await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_7',$2,'합성 평가팀',$3),($4,'class_2026_7',$5,'합성 이동팀',NULL)", [team, 100 + results.length * 2, author, other, 101 + results.length * 2]);
      await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$2,'EVALUATING'),($3,$4,'EVALUATING')", [session, team, `session_${other}`, other]);
      for (const id of [author, target]) await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`member_${id}`, team, id]);
      const peer = scenario.startsWith("peer"), affected = scenario.includes("target") ? target : author;
      const change = () => scenario.endsWith("deactivate") ? deactivateStudent("teacher_bootstrap", affected) : scenario.endsWith("move") ? assignStudent("teacher_bootstrap", affected, other) : removeStudent("teacher_bootstrap", affected, team);
      const save = () => peer ? savePeerEvaluation(author, { roundId, evaluateeId: target, responses, privateEvidence: "", publicComment: "", confirmed: true }) : saveSelfEvaluation(author, { roundId, responses, reflections: ["합성 활동", "합성 성찰"] });
      gate = { ready: deferred(), resume: deferred(), used: false, pid: null, matches: sql => first === "membership" ? sql.includes("SELECT status FROM evaluation_rounds") && sql.includes("FOR UPDATE") : sql.includes(`INSERT INTO ${peer ? "peer_evaluations" : "self_evaluations"}`) };
      const current = gate, writing = settle(save());
      let changing;
      const timer = setTimeout(current.resume.resolve, 12000);
      try {
        await Promise.race([current.ready.promise, writing.then(result => { throw result.error ?? new Error("Evaluation ended before pause"); })]);
        changing = settle(change());
        if (first === "membership") { const changed = await changing; assert.equal(changed.ok, true, changed.error?.message); }
        else await Promise.race([waitBlocked(current.pid), changing.then(() => { throw new Error("Membership changed before evaluation commit"); })]);
      } finally { clearTimeout(timer); current.resume.resolve(); }
      const written = await writing, changed = await changing; gate = null;
      assert.equal(changed.ok, true, changed.error?.message);
      assert.equal(written.ok, reproduce || first === "evaluation", written.error?.message);
      if (!written.ok) assert.match(written.error.message, /팀|소속|평가/);
      const rows = (await app.query(peer ? "SELECT session_id FROM peer_evaluations WHERE round_id=$1 AND evaluator_id=$2 AND evaluatee_id=$3" : "SELECT session_id FROM self_evaluations WHERE round_id=$1 AND student_id=$2", peer ? [roundId, author, target] : [roundId, author])).rows;
      assert.deepEqual(rows, reproduce || first === "evaluation" ? [{ session_id: session }] : []);
      const history = (await app.query("SELECT status,left_at FROM team_members WHERE user_id=$1 AND team_id=$2", [affected, team])).rows;
      assert.equal(history.length, 1); assert.equal(history[0].status, "inactive"); assert.ok(history[0].left_at);
      results.push({ scenario, first, reproduced: reproduce, evaluationSaved: written.ok, membershipHistoryPreserved: true });
      console.log(`${key}: ${reproduce ? "stale write reproduced" : "passed"}`);
    }
  }
  if (!reproduce) {
    for (const id of ["publication_original", "publication_new"]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 공개 학생',$1,2026,'student','class_2026_8','unused',FALSE)", [id]);
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES('publication_team','class_2026_8',100,'합성 공개팀','publication_original')");
    await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES('publication_session','publication_team','REPORTING')");
    await assignStudent("teacher_bootstrap", "publication_original", "publication_team");
    const publicationRound = await createEvaluationRound("teacher_bootstrap", { classNumber: 8, title: "합성 공개 경합", optionalItem: "none" });
    await changeEvaluationRoundStatus("teacher_bootstrap", publicationRound, "open");
    await changeEvaluationRoundStatus("teacher_bootstrap", publicationRound, "close");
    await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: publicationRound, studentId: "publication_original", teacherSummary: "합성 기존 학생 피드백", expectedVersion: null });
    gate = { ready: deferred(), resume: deferred(), used: false, matches: sql => sql.includes("SELECT id FROM users") && sql.includes("FOR UPDATE") };
    let current = gate, publishing = settle(publishEvaluationRound("teacher_bootstrap", publicationRound));
    let timer = setTimeout(current.resume.resolve, 12000);
    try {
      await Promise.race([current.ready.promise, publishing.then(result => { throw result.error ?? new Error("Publication ended before candidate pause"); })]);
      await assignStudent("teacher_bootstrap", "publication_new", "publication_team");
    } finally { clearTimeout(timer); current.resume.resolve(); }
    const rejected = await publishing; gate = null;
    assert.equal(rejected.ok, false); assert.match(rejected.error.message, /평가 대상 팀원이 변경/);
    assert.equal((await app.query("SELECT id FROM evaluation_publications WHERE round_id=$1 AND published_at IS NOT NULL", [publicationRound])).rows.length, 0);
    results.push({ scenario: "new_member_during_publication", rejectedBeforePublishing: true });
    await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: publicationRound, studentId: "publication_new", teacherSummary: "합성 새 학생 피드백", expectedVersion: null });
    gate = { ready: deferred(), resume: deferred(), used: false, matches: sql => sql.includes("INSERT INTO evaluation_publications") };
    current = gate; publishing = settle(publishEvaluationRound("teacher_bootstrap", publicationRound));
    timer = setTimeout(current.resume.resolve, 12000);
    let removing;
    try {
      await Promise.race([current.ready.promise, publishing.then(result => { throw result.error ?? new Error("Publication ended before insert pause"); })]);
      removing = settle(removeStudent("teacher_bootstrap", "publication_new", "publication_team"));
      await Promise.race([waitBlocked(current.pid), removing.then(() => { throw new Error("Removal completed before publication snapshot"); })]);
    } finally { clearTimeout(timer); current.resume.resolve(); }
    const published = await publishing, removed = await removing; gate = null;
    assert.equal(published.ok, true, published.error?.message); assert.equal(removed.ok, true, removed.error?.message);
    assert.equal(published.value.studentCount, 2);
    const readPublished = async () => (await app.query("SELECT student_id,session_id,teacher_summary,peer_averages,approved_comments,published_at FROM evaluation_publications WHERE round_id=$1 ORDER BY student_id", [publicationRound])).rows;
    const before = await readPublished(); assert.equal(before.length, 2); assert.ok(before.every(row => row.published_at));
    assert.equal((await publishEvaluationRound("teacher_bootstrap", publicationRound)).published, false);
    assert.deepEqual(await readPublished(), before);
    assert.equal((await app.query("SELECT status FROM team_members WHERE user_id='publication_new' AND team_id='publication_team'")).rows[0].status, "inactive");
    results.push({ scenario: "publication_before_member_removal", publishedStudents: 2, removedMemberHistoryPreserved: true, repeatedPublicationUnchanged: true });
    console.log("Publication candidate change and removal interleavings: passed");
  }
  await writeFile(new URL(reproduce ? "postgres-evaluation-race-before.json" : "postgres-evaluation-race-after.json", root), JSON.stringify({ database, postgresVersion: identity.version, results }, null, 2));
} finally { await app?.end(); await observer?.end(); await admin.end(); }
