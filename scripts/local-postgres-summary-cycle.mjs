// Real services and disposable loopback PostgreSQL; injected generators never use a network.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("summary_cycle");
globalThis.fetch = async () => { throw new Error("Network forbidden"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { saveDiscussionEntry, getDiscussionData, seoulDate } = await import("../src/lib/discussions.ts");
const { summarizeDiscussionDay, runDailySummaries } = await import("../src/lib/discussion-summary.ts");
const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");
const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const { runDatabaseMigrations } = await import("../src/lib/db/migrations.ts");
const actor = { id: "demo_student_1", role: "student", mustChangePassword: false };
const teacher = { id: "teacher_bootstrap", role: "teacher", mustChangePassword: false };
const date = seoulDate(), results = [];
const summary = async input => ({ items: JSON.parse(input).records.map(row => ({ category: row.kind === "ai_answer" ? "ai_suggestion" : "discussion", text: `합성 기록 ${row.id}`, sourceIds: [row.id] })) });
const analyze = async () => ({ model: "synthetic", result: { overview: "합성 분석", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "측정 확인", rationale: "기록 확인", evidenceIds: ["plan:topic"], feasibleNextStep: "조건 비교", safetyNote: "", questionForStudents: "기준은?" }] } });
async function fixture(key) {
  const session = `session_${key}`, team = `team_${key}`;
  await app.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',$2,'합성 요약 팀')", [team, 300 + results.length]);
  await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
  await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$2,'REPORTING')", [session, team]);
  const cycle = await ensureInitialCycle(app, session, teacher.id);
  await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')", [session, cycle, { topic: "합성 측정" }]);
  await app.query("INSERT INTO reports(id,session_id,cycle_id,status) VALUES($1,$1,$2,'reviewed')", [session, cycle]);
  await saveDiscussionEntry(actor, { id: `entry_${key}`, sessionId: session, cycleId: cycle, kind: "peer", content: `합성 원문 ${key}` });
  return { session, cycle };
}
try {
  // The ninth migration must preserve every old row, including ambiguous summaries.
  await app.query("INSERT INTO discussion_days(session_id,activity_date) VALUES('demo_session_1',$1)", [date]);
  await app.query("INSERT INTO discussion_summaries(id,session_id,activity_date,version,content,sources) VALUES('legacy_summary','demo_session_1',$1,1,'[]','[]')", [date]);
  const legacyBefore = (await app.query("SELECT * FROM discussion_summaries WHERE id='legacy_summary'")).rows[0];
  await app.query("DROP TABLE cycle_discussion_summaries"); await app.query("DROP TABLE cycle_discussion_days"); await app.query("DROP TABLE cycle_discussion_backfills");
  await app.query("DELETE FROM schema_migrations WHERE version='0009'");
  await runDatabaseMigrations(app); await runDatabaseMigrations(app);
  assert.deepEqual((await app.query("SELECT * FROM discussion_summaries WHERE id='legacy_summary'")).rows[0], legacyBefore);
  assert.equal((await app.query("SELECT * FROM cycle_discussion_days")).rows.length, 0);
  results.push("migration keeps legacy rows byte-equivalent and does not guess their cycle");

  const same = await fixture("same_day");
  assert.equal(await summarizeDiscussionDay(same.session, date, summary, same.cycle), true);
  const oldHistory = (await getDiscussionData(teacher, same.session, date, same.cycle)).history;
  await requestCycleAnalysis(same.cycle, "intermediate", teacher.id, analyze);
  const moved = await transitionCycle({ cycleId: same.cycle, action: "start_next", teacherId: teacher.id });
  const nextCycle = (await app.query("SELECT id FROM inquiry_cycles WHERE session_id=$1 AND status='active'", [same.session])).rows[0].id;
  assert.ok(moved); await saveDiscussionEntry(actor, { id: "entry_same_day_next", sessionId: same.session, cycleId: nextCycle, kind: "peer", content: "합성 다음 회차 원문" });
  assert.equal(await summarizeDiscussionDay(same.session, date, async input => {
    assert.deepEqual(JSON.parse(input).records.map(row => row.id), ["entry_same_day_next"]);
    return summary(input);
  }, nextCycle), true);
  const old = await getDiscussionData(teacher, same.session, date, same.cycle), current = await getDiscussionData(teacher, same.session, date, nextCycle);
  assert.deepEqual(old.history, oldHistory); assert.deepEqual(old.sources.map(row => row.id), ["entry_same_day"]);
  assert.deepEqual(current.sources.map(row => row.id), ["entry_same_day_next"]);
  assert.notEqual(current.history[0].id, old.history[0].id);
  assert.equal(await summarizeDiscussionDay(same.session, date, async () => { throw new Error("Closed cycle must not generate"); }, same.cycle), false);
  await assert.rejects(getDiscussionData(teacher, same.session, date, "cycle_wrong_session"), /회차/);
  results.push("same-day cycles generate/read independently; closed summaries remain unchanged and cannot regenerate");

  for (const action of ["start_next", "finish_project"]) {
    const late = await fixture(`late_${action}`);
    let release, reached; const ready = new Promise(resolve => { reached = resolve; }), paused = new Promise(resolve => { release = resolve; });
    const working = summarizeDiscussionDay(late.session, date, async input => { reached(); await paused; return summary(input); }, late.cycle);
    const timer = setTimeout(release, 15000);
    try {
      await Promise.race([ready, working.then(() => { throw new Error("Generator did not reach pause"); })]);
      await requestCycleAnalysis(late.cycle, action === "start_next" ? "intermediate" : "final", teacher.id, analyze);
      await transitionCycle({ cycleId: late.cycle, action, teacherId: teacher.id });
    } finally { clearTimeout(timer); release(); }
    assert.equal(await working, false);
    assert.equal((await app.query("SELECT id FROM cycle_discussion_summaries WHERE cycle_id=$1", [late.cycle])).rows.length, 0);
    assert.equal((await app.query("SELECT id FROM discussion_entries WHERE cycle_id=$1", [late.cycle])).rows.length, 1);
    results.push(`${action}: transition during generation rejects late summary and preserves raw record`);

    const first = await fixture(`first_${action}`);
    await requestCycleAnalysis(first.cycle, action === "start_next" ? "intermediate" : "final", teacher.id, analyze);
    assert.equal(await summarizeDiscussionDay(first.session, date, summary, first.cycle), true);
    await assert.rejects(transitionCycle({ cycleId: first.cycle, action, teacherId: teacher.id }), /자료|기준/);
    results.push(`${action}: summary completed first makes prior analysis stale`);
  }

  const lease = await fixture("lease"); let release, reached;
  const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { release = resolve; });
  const former = summarizeDiscussionDay(lease.session, date, async input => { reached(); await pause; return summary(input); }, lease.cycle);
  const timer = setTimeout(release, 15000);
  try {
    await Promise.race([ready, former.then(() => { throw new Error("Lease generator did not pause"); })]);
    assert.equal(await summarizeDiscussionDay(lease.session, date, summary, lease.cycle), false);
    await app.query("UPDATE cycle_discussion_days SET lease_until='2020-01-01' WHERE cycle_id=$1", [lease.cycle]);
    assert.equal(await summarizeDiscussionDay(lease.session, date, summary, lease.cycle), true);
  } finally { clearTimeout(timer); release(); }
  assert.equal(await former, false);
  assert.equal((await app.query("SELECT id FROM cycle_discussion_summaries WHERE cycle_id=$1", [lease.cycle])).rows.length, 1);
  results.push("duplicate generation is busy; expired lease takeover stores one result and rejects the former owner");

  const demoCycle = (await app.query("SELECT id FROM inquiry_cycles WHERE session_id='demo_session_1' AND status='active'")).rows[0].id;
  for (const [id, timestamp, sequence] of [["before_midnight", "2026-08-20T14:59:00Z", 1], ["after_midnight", "2026-08-20T15:00:00Z", 2]]) await app.query(
    "INSERT INTO messages(id,session_id,cycle_id,role,content,sequence,created_at) VALUES($1,'demo_session_1',$2,'user','합성 날짜 경계',$3,$4)", [id, demoCycle, sequence, timestamp],
  );
  await runDailySummaries(20, summary);
  const days = (await app.query("SELECT activity_date,generated_version FROM cycle_discussion_days WHERE cycle_id=$1 ORDER BY activity_date", [demoCycle])).rows;
  assert.deepEqual(days.map(row => row.activity_date), ["2026-08-20", "2026-08-21"]);
  assert.ok(days.every(row => row.generated_version > 0));
  const legacyView = await getDiscussionData(teacher, "demo_session_1", date, demoCycle);
  assert.equal(legacyView.legacyHistory[0].id, "legacy_summary");
  results.push("backfill splits Korean-midnight AI records correctly and exposes unchanged legacy summaries separately");
  await writeFile(new URL("postgres-summary-cycle.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
  console.log(`${results.length} scoped summary checks passed`);
} finally { await app.end(); }
