import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("exam_config");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { generateExamSet } = await import("../src/lib/exam-service.ts");
const { createClub, createClubTeam, assignClubStudent } = await import("../src/lib/clubs.ts");
const { createClubConfigDraft, publishClubConfig } = await import("../src/lib/club-settings.ts");
const reproduce = process.argv.includes("--reproduce"), results = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const connect = app.connect.bind(app);
let gate;
app.connect = (...args) => args.length ? connect(...args) : (async () => {
  const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
  client.query = async (...args) => {
    const selected = gate && !gate.used && gate.matches(String(args[0])) ? gate : null;
    if (selected) selected.used = true;
    const pause = async () => { selected.pid = client.processID; selected.ready.resolve(); await selected.resume.promise; };
    if (selected && !selected.after) await pause();
    const value = await query(...args);
    if (selected?.after) await pause();
    return value;
  };
  client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
  return client;
})();
async function blocked(pid) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if ((await app.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND $2::integer=ANY(pg_blocking_pids(pid))", [database, pid])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Expected lock wait was not observed");
}
try {
  await app.query("UPDATE users SET must_change_password=FALSE WHERE id='teacher_bootstrap'");
  for (const republish of [false, true]) for (const first of ["exam", "config"]) {
    const name = `합성 설정 ${republish} ${first}`, club = await createClub("teacher_bootstrap", name);
    const old = await createClubConfigDraft("teacher_bootstrap", { clubId: club, configType: "exam" });
    await publishClubConfig("teacher_bootstrap", old, name);
    const next = republish ? old : await createClubConfigDraft("teacher_bootstrap", { clubId: club, configType: "exam" });
    const team = await createClubTeam("teacher_bootstrap", club, "합성 시험팀");
    const student = `exam_config_${republish}_${first}`;
    await app.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 수험생',$1,2026,'student','unused',FALSE)", [student]);
    await app.query("INSERT INTO club_members(club_id,user_id) VALUES($1,$2)", [club, student]);
    await assignClubStudent("teacher_bootstrap", club, student, team);
    const oldDefinition = (await app.query("SELECT definition FROM club_config_versions WHERE id=$1", [old])).rows[0].definition;
    const generated = deferred(), releaseGeneration = deferred();
    const generator = {
      generateCommon: async () => [{ stimulus: "합성 자료", question: "합성 문제", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }],
      generateTeam: async () => { generated.resolve(); await releaseGeneration.promise; return { teamQuestions: [], individualQuestions: [] }; },
    };
    gate = { used: false, ready: deferred(), resume: deferred(), after: first === "config", matches: sql => first === "exam" ? sql.includes("INSERT INTO exam_sets") : sql.includes("SELECT v.club_id, c.name AS club_name") && sql.includes("FOR UPDATE") };
    const current = gate;
    const exam = settle(generateExamSet("teacher_bootstrap", { clubId: club, configVersionId: old, title: name, commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성 범위" }, generator));
    let publication;
    const timer = setTimeout(() => { releaseGeneration.resolve(); current.resume.resolve(); }, 12000);
    try {
      await Promise.race([generated.promise, exam.then(result => { throw result.error ?? new Error("Generation ended before pause"); })]);
      if (first === "exam") {
        releaseGeneration.resolve();
        await Promise.race([current.ready.promise, exam.then(result => { throw result.error ?? new Error("Exam ended before gate"); })]);
        publication = settle(publishClubConfig("teacher_bootstrap", next, name));
        await Promise.race([blocked(current.pid), publication.then(result => { throw result.error ?? new Error("Publication did not wait"); })]);
      } else {
        publication = settle(publishClubConfig("teacher_bootstrap", next, name));
        await Promise.race([current.ready.promise, publication.then(result => { throw result.error ?? new Error("Publication ended before gate"); })]);
        releaseGeneration.resolve();
        await Promise.race([blocked(current.pid), exam.then(result => { throw result.error ?? new Error("Exam did not wait"); })]);
      }
    } finally { clearTimeout(timer); releaseGeneration.resolve(); current.resume.resolve(); }
    const saved = await exam, published = await publication; gate = null;
    const deadlock = saved.error?.code === "40P01" || published.error?.code === "40P01";
    if (reproduce && republish && first === "exam") assert.equal(deadlock, true, "Expected the old version/club lock inversion");
    else {
      assert.equal(saved.ok, true, saved.error?.message);
      assert.equal(published.ok, !republish, published.error?.message);
      if (republish) assert.match(published.error.message, /초안만/);
      assert.equal(deadlock, false);
    }
    if (saved.ok) {
      assert.equal((await app.query("SELECT config_version_id FROM exam_sets WHERE id=$1", [saved.value])).rows[0].config_version_id, old);
      assert.equal((await app.query("SELECT student_id FROM exams WHERE exam_set_id=$1", [saved.value])).rows[0].student_id, student);
    }
    assert.deepEqual((await app.query("SELECT definition FROM club_config_versions WHERE id=$1", [old])).rows[0].definition, oldDefinition);
    results.push({ republish, first, deadlock, examSaved: saved.ok, configPublished: published.ok, observedLockWait: true, pinnedDefinitionPreserved: true });
    console.log(`${republish ? "republish" : "new_version"}_${first}: ${deadlock ? "deadlock reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-exam-config-before-50.json" : "postgres-exam-config-after-50.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { gate?.resume.resolve(); await app.end(); }
