// Real app services against a fresh, identified loopback PostgreSQL database.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("summary_archive");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { saveDiscussionEntry, getDiscussionData, seoulDate } = await import("../src/lib/discussions.ts");
const { summarizeDiscussionDay } = await import("../src/lib/discussion-summary.ts");
const { archiveTeam, restoreTeam } = await import("../src/lib/teams.ts");
const date = seoulDate(), teacher = { id: "teacher_bootstrap", role: "teacher", mustChangePassword: false }, student = { id: "demo_student_1", role: "student", mustChangePassword: false };
const summary = async input => ({ items: JSON.parse(input).records.map(row => ({ category: "discussion", text: "합성 보관 경합 기록", sourceIds: [row.id] })) });
const results = [];
let gate = null;
const connect = app.connect.bind(app);
app.connect = (...args) => {
  if (args.length) return connect(...args);
  return (async () => {
    const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
    client.query = async (...queryArgs) => {
      const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0].text;
      if (gate && !gate.used && sql.includes("INSERT INTO cycle_discussion_summaries")) {
        gate.used = true;
        const selected = gate;
        selected.pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        selected.reached(); await selected.resume;
      }
      return query(...queryArgs);
    };
    client.release = (...releaseArgs) => { client.query = query; client.release = release; return release(...releaseArgs); };
    return client;
  })();
};
async function fixture(key) {
  const session = `session_${key}`, team = `team_${key}`, name = `합성 ${key} 팀`;
  await app.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',$2,$3)", [team, 600 + results.length, name]);
  await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
  await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$2)", [session, team]);
  const cycle = await ensureInitialCycle(app, session, teacher.id);
  await saveDiscussionEntry(student, { id: `entry_${key}`, sessionId: session, cycleId: cycle, kind: "peer", content: `합성 보존 원문 ${key}` });
  return { session, team, cycle, archive: () => archiveTeam(teacher.id, team, `9반 ${name}`) };
}
try {
  const before = await fixture("before"); let calls = 0;
  await before.archive();
  assert.equal(await summarizeDiscussionDay(before.session, date, async input => { calls++; return summary(input); }, before.cycle), false);
  assert.equal(calls, 0);
  const archived = await getDiscussionData(teacher, before.session, date, before.cycle);
  assert.equal(archived.sources.length, 1);
  await assert.rejects(getDiscussionData(student, before.session, date, before.cycle), /접근/);
  await restoreTeam(teacher.id, before.team);
  assert.equal(await summarizeDiscussionDay(before.session, date, summary, before.cycle), true);
  results.push("archived team cannot start generation; teacher retains raw access; restored team can generate");

  const during = await fixture("during"); let release, reached;
  const ready = new Promise(resolve => { reached = resolve; }), paused = new Promise(resolve => { release = resolve; });
  const working = summarizeDiscussionDay(during.session, date, async input => { reached(); await paused; return summary(input); }, during.cycle);
  const timer = setTimeout(release, 15000);
  try {
    await Promise.race([ready, working.then(() => { throw new Error("Generation did not pause"); })]);
    await during.archive();
  } finally { clearTimeout(timer); release(); }
  assert.equal(await working, false);
  assert.equal((await app.query("SELECT id FROM cycle_discussion_summaries WHERE cycle_id=$1", [during.cycle])).rows.length, 0);
  const sources = (await getDiscussionData(teacher, during.session, date, during.cycle)).sources;
  assert.equal(sources.length, 1);
  await restoreTeam(teacher.id, during.team);
  // Move only the synthetic retry clock; do not change application retry behavior.
  await app.query("UPDATE cycle_discussion_days SET retry_after=NULL WHERE cycle_id=$1", [during.cycle]);
  assert.equal(await summarizeDiscussionDay(during.session, date, summary, during.cycle), true);
  assert.deepEqual((await getDiscussionData(teacher, during.session, date, during.cycle)).sources, sources);
  assert.equal((await app.query("SELECT id FROM cycle_discussion_summaries WHERE cycle_id=$1", [during.cycle])).rows.length, 1);
  results.push("archive during generation rejects its late result; restore/retry keeps original sources and stores one summary");

  const first = await fixture("writer_first"); let reachedWrite, resumeWrite;
  const readyWrite = new Promise(resolve => { reachedWrite = resolve; }), resume = new Promise(resolve => { resumeWrite = resolve; });
  gate = { used: false, reached: reachedWrite, resume, pid: null };
  const writing = summarizeDiscussionDay(first.session, date, summary, first.cycle);
  let archiving, waited = false;
  const writeTimer = setTimeout(resumeWrite, 15000);
  try {
    await Promise.race([readyWrite, writing.then(() => { throw new Error("Writer did not reach insert"); })]);
    archiving = first.archive();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const blockers = (await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int = ANY(pg_blocking_pids(pid))", [gate.pid])).rows;
      if (blockers.length) { waited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(waited, true, "Archive must wait for the summary's team row lock");
  } finally { clearTimeout(writeTimer); resumeWrite(); }
  assert.equal(await writing, true); await archiving; gate = null;
  const history = (await getDiscussionData(teacher, first.session, date, first.cycle)).history;
  assert.equal(history.length, 1);
  await restoreTeam(teacher.id, first.team);
  assert.equal(await summarizeDiscussionDay(first.session, date, summary, first.cycle), false);
  assert.deepEqual((await getDiscussionData(teacher, first.session, date, first.cycle)).history, history);
  results.push("summary writer holds team lock; archive visibly waits; archive/restore preserves the single fixed summary");
  await writeFile(new URL("postgres-summary-archive.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
  console.log(`${results.length} archive/restore summary checks passed`);
} finally { await app.end(); }
