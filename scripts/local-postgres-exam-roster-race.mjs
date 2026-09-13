import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("exam_roster");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { generateExamSet } = await import("../src/lib/exam-service.ts");
const { removeStudent, assignStudent, archiveTeam, createTeam } = await import("../src/lib/teams.ts");
const { deactivateStudent } = await import("../src/lib/student-management.ts");
const { assignClubStudent, createClubTeam } = await import("../src/lib/clubs.ts");
const scopeChanges = process.argv.includes("--scope-changes");
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
  await app.query("UPDATE users SET must_change_password=FALSE WHERE id='teacher_bootstrap'");
  for (const club of [false, true]) for (const action of (scopeChanges ? ["empty_add", "new_add", "new_empty"] : ["remove", "deactivate", "move", "add", "archive"])) for (const first of ["change", "save"]) {
    const key = `exam_race_${club}_${action}_${first}`, student = `${key}_student`, added = `${key}_added`, target = `${key}_target`;
    if (club) {
      await app.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 동아리','teacher_bootstrap')", [key]);
      await app.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
      await app.query("INSERT INTO club_config_versions(id,club_id,config_type,version_number,title,status,created_by) VALUES($1,$1,'exam',1,'합성 설정','published','teacher_bootstrap')", [key]);
    }
    for (const id of [student, added]) {
      await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 수험생',$1,2026,'student',$2,'unused',FALSE)", [id, club ? null : "class_2026_7"]);
      if (club) await app.query("INSERT INTO club_members(club_id,user_id) VALUES($1,$2)", [key, id]);
    }
    for (const id of [key, target]) {
      await app.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,$4,'합성 시험팀')", [id, club ? null : "class_2026_7", club ? key : null, 100 + results.length * 2 + Number(id === target)]);
      await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [id]);
    }
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, student]);
    await app.query("INSERT INTO investigation_plans(id,session_id,form_data) VALUES($1,$1,$2)", [key, JSON.stringify({ topic: "보존할 합성 원문" })]);
    await app.query("INSERT INTO reports(id,session_id,form_data) VALUES($1,$1,$2)", [key, JSON.stringify({ analysis: "보존할 합성 분석" })]);
    const original = async () => ({ plan: (await app.query("SELECT * FROM investigation_plans WHERE id=$1", [key])).rows, report: (await app.query("SELECT * FROM reports WHERE id=$1", [key])).rows });
    const before = await original();
    const generator = { generateCommon: async () => [{ stimulus: "합성 자료", question: "합성 문제", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }], generateTeam: async () => ({ teamQuestions: [], individualQuestions: [] }) };
    const assign = (id, team) => club ? assignClubStudent("teacher_bootstrap", key, id, team) : assignStudent("teacher_bootstrap", id, team);
    let createdTeam;
    const change = async () => {
      if (action === "empty_add") return assign(added, target);
      if (action === "new_add" || action === "new_empty") {
        createdTeam = club ? await createClubTeam("teacher_bootstrap", key, "새 합성 팀") : await createTeam("teacher_bootstrap", 7, 10 + results.length);
        if (action === "new_add") await assign(added, createdTeam);
        return;
      }
      return action === "remove" ? removeStudent("teacher_bootstrap", student, key)
      : action === "deactivate" ? deactivateStudent("teacher_bootstrap", student)
      : action === "move" ? assign(student, target)
      : action === "add" ? assign(added, key)
      : archiveTeam("teacher_bootstrap", key, `${club ? "합성 동아리" : "7반"} 합성 시험팀`);
    };
    gate = { ready: deferred(), resume: deferred(), used: false, matches: sql => first === "change"
      ? (scopeChanges ? /SELECT id FROM (classes|clubs) WHERE id = \$1/.test(sql) : sql.includes("SELECT team_id FROM inquiry_sessions")) && sql.includes("FOR UPDATE")
      : sql.includes("INSERT INTO exam_sets") };
    const current = gate;
    const saving = settle(generateExamSet("teacher_bootstrap", { ...(club ? { clubId: key } : { classNumber: 7 }), title: key, commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 범위" }, generator));
    let changing;
    const timer = setTimeout(current.resume.resolve, 12000);
    try {
      await Promise.race([current.ready.promise, saving.then(result => { throw result.error ?? new Error("Generation ended before gate"); })]);
      changing = settle(change());
      if (first === "change") { const changed = await changing; assert.equal(changed.ok, true, changed.error?.message); }
      else await Promise.race([waitBlocked(current.pid), changing.then(() => { throw new Error("Change completed before the locked save"); })]);
    } finally { clearTimeout(timer); current.resume.resolve(); }
    const saved = await saving, changed = await changing; gate = null;
    assert.equal(changed.ok, true, changed.error?.message);
    const expectedSave = first === "save" || action === "new_empty";
    assert.equal(saved.ok, expectedSave, saved.error?.message);
    if (!saved.ok) assert.equal(saved.error.status, 409);
    const sets = (await app.query("SELECT id FROM exam_sets WHERE title=$1", [key])).rows;
    assert.equal(sets.length, Number(expectedSave));
    if (saved.ok) {
      const papers = (await app.query("SELECT * FROM exams WHERE exam_set_id=$1", [saved.value])).rows;
      assert.equal(papers.length, 1); assert.equal(papers[0].student_id, student); assert.equal(papers[0].session_id, key);
      const questions = (await app.query("SELECT * FROM exam_questions WHERE exam_set_id=$1", [saved.value])).rows;
      assert.equal(questions.length, 1); assert.equal(questions[0].question, "합성 문제");
    }
    assert.deepEqual(await original(), before);
    const oldMember = (await app.query("SELECT * FROM team_members WHERE id=$1", [key])).rows;
    assert.equal(oldMember.length, 1);
    if (["remove", "move", "deactivate"].includes(action)) { assert.equal(oldMember[0].status, "inactive"); assert.ok(oldMember[0].left_at); }
    if (action === "move") assert.equal((await app.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2", [target, student])).rows[0].status, "active");
    if (action === "add") assert.equal((await app.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2", [key, added])).rows[0].status, "active");
    if (action === "empty_add" || action === "new_add") assert.equal((await app.query("SELECT status FROM team_members WHERE team_id=$1 AND user_id=$2", [createdTeam ?? target, added])).rows[0].status, "active");
    if (action === "archive") assert.equal((await app.query("SELECT status FROM teams WHERE id=$1", [key])).rows[0].status, "archived");
    results.push({ club, action, first, observedLockWait: first === "save", examSaved: saved.ok, sourcePreserved: true, membershipHistoryPreserved: true });
    console.log(`${key}: passed`);
    await app.query("UPDATE teams SET status='archived' WHERE id=$1 OR id=$2 OR id=$3", [key, target, createdTeam ?? null]);
  }
  await writeFile(new URL(scopeChanges ? "postgres-exam-scope-race-49.json" : "postgres-exam-roster-race-48.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { gate?.resume.resolve(); await app.end(); }
