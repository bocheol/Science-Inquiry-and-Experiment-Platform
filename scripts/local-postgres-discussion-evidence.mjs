// Disposable loopback PostgreSQL only. No external AI or student data.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("discussion_evidence");
globalThis.fetch = async () => { throw new Error("Network disabled"); };
const { captureCycleEvidenceSnapshot, buildCycleEvidencePayload, cycleEvidenceHash } = await import("../src/lib/cycle-evidence.ts");
const { runDatabaseMigrations } = await import("../src/lib/db/migrations.ts");
const { saveDiscussionEntry, readDiscussionSources, seoulDate } = await import("../src/lib/discussions.ts");
const { summarizeDiscussionDay } = await import("../src/lib/discussion-summary.ts");
const { prepareCycleAnalysisInput } = await import("../src/lib/cycle-analysis.ts");
const session = "demo_session_1", actor = { id: "demo_student_1", role: "student", mustChangePassword: false }, date = seoulDate();
const results = [];
try {
  const oldCycle = (await app.query("SELECT id FROM inquiry_cycles WHERE session_id=$1 AND status='active'", [session])).rows[0].id;
  const oldSnapshot = await captureCycleEvidenceSnapshot(app, oldCycle, "teacher_bootstrap");
  // Reconstruct the immediately preceding schema using this empty synthetic snapshot.
  // There are no real records and no server is attached to this disposable database.
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP INDEX idx_discussion_entries_cycle");
    await client.query("ALTER TABLE cycle_evidence_snapshots DROP COLUMN discussion_entries");
    await client.query("DELETE FROM schema_migrations WHERE version='0008'");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const previousRow = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE id=$1", [oldSnapshot.id])).rows[0];
  await runDatabaseMigrations(app); await runDatabaseMigrations(app);
  const { discussion_entries, ...migratedRow } = (await app.query("SELECT * FROM cycle_evidence_snapshots WHERE id=$1", [oldSnapshot.id])).rows[0];
  assert.equal(discussion_entries, null); assert.deepEqual(migratedRow, previousRow);
  assert.equal((await app.query("SELECT version FROM schema_migrations WHERE version='0008'")).rows.length, 1);
  results.push("migration preserves every old snapshot field and leaves unknown raw evidence null");

  await saveDiscussionEntry(actor, { id: "prior_cycle_message", sessionId: session, cycleId: oldCycle, kind: "peer", content: "이전 회차 합성 대화" });
  await app.query("UPDATE inquiry_cycles SET status='completed',ended_at=CURRENT_TIMESTAMP WHERE id=$1", [oldCycle]);
  const cycle = "synthetic_second_cycle";
  await app.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,started_at) VALUES($1,$2,2,'합성 2차',CURRENT_TIMESTAMP)", [cycle, session]);
  await app.query("UPDATE investigation_plans SET cycle_id=$1 WHERE session_id=$2", [cycle, session]);
  await app.query("UPDATE reports SET cycle_id=$1 WHERE session_id=$2", [cycle, session]);
  await saveDiscussionEntry(actor, { id: "current_cycle_message", sessionId: session, cycleId: cycle, kind: "peer", content: "현재 회차 합성 대화" });
  const rawFeed = await readDiscussionSources(session, date);
  assert.deepEqual(rawFeed.map(row => row.id), ["current_cycle_message"]);
  assert.equal(await summarizeDiscussionDay(session, date, async input => {
    const { records } = JSON.parse(input);
    assert.equal(records.length, 1);
    return { items: [{ category: "discussion", text: "현재 회차 합성 대화", sourceIds: records.map(row => row.id) }] };
  }), true);
  const snapshot = await captureCycleEvidenceSnapshot(app, cycle, "teacher_bootstrap");
  assert.equal(snapshot.discussionSummaries.length, 1);
  assert.deepEqual(snapshot.discussionEntries.map(row => row.evidenceId), ["entry:current_cycle_message"]);
  const prepared = prepareCycleAnalysisInput(snapshot, text => text);
  assert.ok(prepared.sourceIds.includes("entry:current_cycle_message"));
  assert.ok(!prepared.text.includes("이전 회차 합성 대화"));
  assert.equal((await app.query("SELECT id FROM cycle_discussion_summaries WHERE session_id=$1", [session])).rows.length, 1);
  results.push("daily summary and cycle analysis retain only their own same-day cycle sources");
  await saveDiscussionEntry(actor, { id: "later_cycle_message", sessionId: session, cycleId: cycle, kind: "peer", content: "요약 전 추가 합성 질문" });
  assert.notEqual(cycleEvidenceHash(await buildCycleEvidencePayload(app, cycle)), snapshot.contentHash);
  const frozen = (await app.query("SELECT discussion_entries FROM cycle_evidence_snapshots WHERE id=$1", [snapshot.id])).rows[0].discussion_entries;
  assert.deepEqual(frozen, snapshot.discussionEntries);
  results.push("new unsummarized source invalidates current evidence while the captured raw record remains unchanged");
  await writeFile(new URL("postgres-discussion-evidence-scoped.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
  console.log(`${results.length} discussion evidence / migration checks passed`);
} finally { await app.end(); }
