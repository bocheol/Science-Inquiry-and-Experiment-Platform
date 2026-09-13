import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("exam_teacher");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { generateExamSet } = await import("../src/lib/exam-service.ts");
const { changeManagedAccountStatus } = await import("../src/lib/master-accounts.ts");
const { updatePassword } = await import("../src/lib/auth.ts");
const { setClubTeacherAssignment } = await import("../src/lib/club-settings.ts");
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
    const waiting = await app.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND $2::integer=ANY(pg_blocking_pids(pid))", [database, pid]);
    if (waiting.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Expected actual PostgreSQL lock wait was not observed");
}
const results = [];
try {
  for (const club of [false, true]) for (const action of (club ? ["deactivate", "password", "unassign"] : ["deactivate", "password"])) for (const phase of ["start", "generating", "change_first", "save_first"]) {
    const key = `exam_teacher_${club}_${action}_${phase}`, teacher = `${key}_teacher`, master = `${key}_master`, student = `${key}_student`;
    for (const [id, role, isMaster] of [[teacher, "teacher", false], [master, "teacher", true], [student, "student", false]]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 계정',$1,2026,$2,'unused',FALSE,$3)", [id, role, isMaster]);
    if (club) {
      await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리',$2)", [key, teacher]);
      await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,$2)", [key, teacher]);
      await app.query("INSERT INTO club_config_versions(id,club_id,config_type,version_number,title,status,created_by) VALUES($1,$1,'exam',1,'합성 설정','published',$2)", [key, teacher]);
    }
    await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 시험팀')", [key, club ? null : "class_2026_4", club ? key : null, 100 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, student]);
    const member = (await app.query("SELECT * FROM team_members WHERE id=$1", [key])).rows;
    const change = () => action === "deactivate" ? changeManagedAccountStatus(master, teacher, "deactivate") : action === "password" ? updatePassword(teacher, "synthetic-reset-only", true) : setClubTeacherAssignment(master, key, teacher, false);
    const generated = deferred(), releaseGeneration = deferred();
    let calls = 0;
    const generator = {
      generateCommon: async () => { calls++; return [{ stimulus: "합성 자료", question: "합성 문제", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }]; },
      generateTeam: async () => { if (phase === "generating") { generated.resolve(); await releaseGeneration.promise; } return { teamQuestions: [], individualQuestions: [] }; },
    };
    const input = { ...(club ? { clubId: key } : { classNumber: 4 }), title: key, commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 범위" };
    const read = async () => ({ sets: (await app.query("SELECT * FROM exam_sets WHERE title=$1", [key])).rows, papers: (await app.query("SELECT * FROM exams WHERE student_id=$1 ORDER BY id", [student])).rows, questions: (await app.query("SELECT q.* FROM exam_questions q JOIN exam_sets s ON s.id=q.exam_set_id WHERE s.title=$1 ORDER BY q.id", [key])).rows });
    if (phase === "start") await change();
    if (phase === "change_first" || phase === "save_first") gate = { ready: deferred(), resume: deferred(), used: false, matches: sql => phase === "change_first" ? sql.includes("SELECT team_id FROM inquiry_sessions") && sql.includes("FOR UPDATE") : sql.includes("INSERT INTO exam_sets") };
    const current = gate;
    const saving = settle(generateExamSet(teacher, input, generator));
    let changing;
    const timer = setTimeout(() => { current?.resume.resolve(); releaseGeneration.resolve(); }, 12000);
    try {
      if (phase === "generating") {
        await Promise.race([generated.promise, saving.then(result => { throw result.error ?? new Error("Exam ended before generation pause"); })]);
        await change();
      } else if (current) {
        await Promise.race([current.ready.promise, saving.then(result => { throw result.error ?? new Error("Exam ended before query gate"); })]);
        changing = settle(change());
        if (phase === "change_first") { const changed = await changing; assert.equal(changed.ok, true, changed.error?.message); }
        else await Promise.race([waitBlocked(current.pid), changing.then(result => { throw result.error ?? new Error("Authority changed before save commit"); })]);
      }
    } finally { clearTimeout(timer); current?.resume.resolve(); releaseGeneration.resolve(); }
    const saved = await saving;
    if (changing) { const changed = await changing; assert.equal(changed.ok, true, changed.error?.message); }
    gate = null;
    assert.equal(saved.ok, phase === "save_first", saved.error?.message);
    if (!saved.ok) assert.equal(saved.error.status, 403);
    assert.equal(calls, phase === "start" ? 0 : 1);
    const snapshot = await read();
    assert.equal(snapshot.sets.length, Number(saved.ok));
    assert.equal(snapshot.papers.length, Number(saved.ok));
    assert.equal(snapshot.questions.length, Number(saved.ok));
    if (saved.ok) { assert.equal(snapshot.papers[0].student_id, student); assert.equal(snapshot.questions[0].question, "합성 문제"); }
    const jobs = (await app.query("SELECT status FROM ai_generation_jobs WHERE created_by=$1", [teacher])).rows;
    assert.equal(jobs.length, phase === "start" ? 0 : 1);
    if (jobs.length) assert.equal(jobs[0].status, saved.ok ? "completed" : "failed");
    await assert.rejects(generateExamSet(teacher, input, generator), error => error.status === 403);
    assert.equal(calls, phase === "start" ? 0 : 1);
    assert.deepEqual(await read(), snapshot);
    assert.deepEqual((await app.query("SELECT * FROM team_members WHERE id=$1", [key])).rows, member);
    results.push({ club, action, phase, observedLockWait: phase === "save_first", examSaved: saved.ok, generationCalls: calls, retryDenied: true, priorExamPreserved: true, membershipPreserved: true });
    console.log(`${key}: passed`);
    await app.query("UPDATE teams SET status='archived' WHERE id=$1", [key]);
  }
  await writeFile(new URL("postgres-exam-teacher-race-52.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { gate?.resume.resolve(); await app.end(); }
