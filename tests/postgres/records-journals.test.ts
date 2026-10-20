import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { SCHEMA_SQL } from "@/lib/db/schema";
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from "@/lib/db/migrations";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { buildCycleEvidencePayload } from "@/lib/cycle-evidence";
import { canReadTeamJournals } from "@/lib/journal-access";
import { assertRecordStudent, type RecordActor } from "@/lib/student-records/access";
import { getRecordWorkspace, recordHistory, saveRecordDraft, saveRecordSubmission } from "@/lib/student-records/service";
import { getRecordFile, uploadRecordFile } from "@/lib/student-records/files";

let db: Pool;
let cycleId: string;
let originalJournals: unknown[];
const owner: RecordActor = { id: "integration_student_a", role: "student", mustChangePassword: false };
const peer: RecordActor = { id: "integration_student_b", role: "student", mustChangePassword: false };
const teacher: RecordActor = { id: "integration_teacher2", role: "teacher", mustChangePassword: false };
const shared: RecordActor = { id: "integration_teacher1", role: "teacher", mustChangePassword: false };
const master: RecordActor = { id: "integration_master", role: "teacher", mustChangePassword: false };
const globals = globalThis as typeof globalThis & { __sciencePool?: Pool; __scienceDbReady?: Promise<Pool> };

beforeAll(async () => {
  // Opt-in, loopback-only and empty-database checks prevent accidental production use.
  if (process.env.SCIENCE_POSTGRES_INTEGRATION !== "1") throw new Error("Explicit isolated PostgreSQL test opt-in is required.");
  const url = new URL(process.env.SCIENCE_TEST_POSTGRES_URL || "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.pathname !== "/science_inquiry_integration") {
    throw new Error("Use the dedicated local science_inquiry_integration test database only.");
  }
  vi.stubEnv("DATABASE_URL", url.toString());
  db = new Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 5000, application_name: "science-inquiry-integration-tests" });
  const existing = await db.query("SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'");
  if (existing.rows[0].count !== 0) throw new Error("The integration test database must be empty; no existing data will be deleted.");
  await db.query(SCHEMA_SQL);
  await runDatabaseMigrations(db, DATABASE_MIGRATIONS.filter(m => m.version <= "0012"));
  for (let n = 1; n <= 9; n++) await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,2026,$2,$1)", ["integration_class_" + n, n]);
  for (const [login, name] of [["teacher1", "강석봉"], ["teacher2", "김보철"], ["teacher3", "김정원"], ["teacher4", "원창연"]]) {
    await db.query("INSERT INTO users(id,login_id,name,academic_year,role,password_hash,must_change_password) VALUES($1,$2,$3,2026,'teacher','synthetic',FALSE)", ["integration_" + login, login, name]);
  }
  await db.query("INSERT INTO users(id,login_id,name,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'synthetic-master','합성 마스터',2026,'teacher','synthetic',FALSE,TRUE)", [master.id]);
  for (const [id, login] of [[owner.id, "10901"], [peer.id, "10902"]]) {
    await db.query("INSERT INTO users(id,login_id,name,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,$2,'합성 학생',2026,'student','integration_class_9','synthetic',FALSE)", [id, login]);
  }
  await db.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES('integration_team','integration_class_9',1,'합성 탐구팀',$1)", [owner.id]);
  for (const id of [owner.id, peer.id]) await db.query("INSERT INTO team_members(id,team_id,user_id,joined_at) VALUES($1,'integration_team',$2,'2026-09-01')", ["member_" + id, id]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES('integration_session','integration_team','EXPERIMENTING')");
  cycleId = await ensureInitialCycle(db, "integration_session");
  await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES('integration_plan','integration_session',$1,$2,'approved')", [cycleId, JSON.stringify({ topic: "합성 팀 계획" })]);
  await db.query("INSERT INTO reports(id,session_id,cycle_id,form_data) VALUES('integration_report','integration_session',$1,$2)", [cycleId, JSON.stringify({ analysis: "합성 팀 보고" })]);
  for (const [id, text] of [[owner.id, "OWNER_PRIVATE_OBSERVATION"], [peer.id, "PEER_PRIVATE_OBSERVATION"]]) {
    await db.query("INSERT INTO experiment_journals(id,session_id,cycle_id,student_id,session_number,journal_date,activities,observations,reflections) VALUES($1,'integration_session',$2,$3,1,'2026-10-01',$4,'관찰','성찰')", ["journal_" + id, cycleId, id, text]);
  }
  originalJournals = (await db.query("SELECT * FROM experiment_journals ORDER BY id")).rows;
  // Two application startups must not race or change already-applied checksums.
  await Promise.all([runDatabaseMigrations(db), runDatabaseMigrations(db)]);
  globals.__sciencePool = db;
});

afterAll(async () => {
  delete globals.__sciencePool; delete globals.__scienceDbReady;
  await db?.end(); vi.unstubAllEnvs();
});

it("upgrades through 0013/0014/0015 once and preserves existing journals", async () => {
  const versions = (await db.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(r => r.version);
  expect(versions).toEqual(DATABASE_MIGRATIONS.map(m => m.version));
  expect(versions.slice(-3)).toEqual(["0013", "0014", "0015"]);
  expect((await db.query("SELECT * FROM experiment_journals ORDER BY id")).rows).toEqual(originalJournals);
  const grants = (await db.query("SELECT c.class_number,a.teacher_id FROM record_teacher_classes a JOIN classes c ON c.id=a.class_id ORDER BY c.class_number")).rows;
  expect(grants.map(r => r.teacher_id)).toEqual(["integration_teacher4", "integration_teacher4", "integration_teacher1", "integration_teacher1", "integration_teacher3", "integration_teacher3", "integration_teacher3", "integration_teacher2", "integration_teacher2"]);
  await runDatabaseMigrations(db);
  expect((await db.query("SELECT COUNT(*)::int AS count FROM record_teacher_classes")).rows[0].count).toBe(9);
});

it("keeps journal shared/master authority separate from assigned-class record authority", async () => {
  await db.query("INSERT INTO class_journal_teacher_assignments(class_id,teacher_id) VALUES('integration_class_9',$1)", [shared.id]);
  for (const actor of [shared, master]) {
    expect(await canReadTeamJournals(db, actor.id, "integration_team")).toBe(true);
    await expect(assertRecordStudent(db, actor, owner.id)).rejects.toMatchObject({ status: 403 });
  }
  const workspace = await getRecordWorkspace(teacher, owner.id);
  expect(JSON.stringify(workspace.evidence)).toContain("OWNER_PRIVATE_OBSERVATION");
  expect(JSON.stringify(workspace.evidence)).not.toContain("PEER_PRIVATE_OBSERVATION");
  const publicEvidence = JSON.stringify(await buildCycleEvidencePayload(db, cycleId));
  expect(publicEvidence).not.toContain("OWNER_PRIVATE_OBSERVATION");
  expect(publicEvidence).not.toContain("PEER_PRIVATE_OBSERVATION");
});

it("serializes simultaneous student saves without losing a submission version", async () => {
  const make = (text: string) => ({ expectedRevision: 0, selected: ["egg", "spectrum"], comments: { egg: text }, submit: true });
  const results = await Promise.allSettled([saveRecordSubmission(owner, owner.id, make("first concurrent input")), saveRecordSubmission(owner, owner.id, make("second concurrent input"))]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  const history = await recordHistory(teacher, owner.id);
  expect(history.submissions).toHaveLength(1);
  expect((await getRecordWorkspace(owner, owner.id)).submission.revision).toBe(1);
});

it("deduplicates simultaneous teacher/student uploads and protects original bytes", async () => {
  const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC ORIGINAL FOR CONCURRENCY TEST");
  const results = await Promise.all([uploadRecordFile(owner, owner.id, "individual_plan", "synthetic.pdf", bytes), uploadRecordFile(teacher, owner.id, "individual_plan", "synthetic-copy.pdf", bytes)]);
  expect(results[0].id).toBe(results[1].id);
  expect(results.filter(r => r.duplicate)).toHaveLength(1);
  expect(Buffer.from((await getRecordFile(owner, results[0].id)).file_data)).toEqual(bytes);
  await expect(getRecordFile(peer, results[0].id)).rejects.toMatchObject({ status: 403 });
});

it("rechecks a revoked account after waiting for the account row lock", async () => {
  const blocker = await db.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner.id]);
    // Convert rejection immediately so the expected 403 is never unhandled.
    pending = saveRecordSubmission(owner, owner.id, { expectedRevision: 1, selected: ["egg", "spectrum"], comments: {}, submit: true }).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(async () => {
      const waiting = await db.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE application_name='science-inquiry-integration-tests' AND wait_event_type='Lock'");
      expect(waiting.rows[0].n).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 20 });
    await blocker.query("UPDATE users SET status='inactive' WHERE id=$1", [owner.id]);
    await blocker.query("COMMIT");
    expect(await pending).toMatchObject({ error: { status: 403 } });
    expect((await db.query("SELECT revision FROM record_submissions WHERE student_id=$1", [owner.id])).rows[0].revision).toBe(1);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release(); await pending;
    await db.query("UPDATE users SET status='active' WHERE id=$1", [owner.id]);
  }
});

it("finalizes exactly 1500 bytes, hides teacher prose and rejects changed evidence", async () => {
  const workspace = await getRecordWorkspace(teacher, owner.id);
  const input = { expectedRevision: 0, expectedSubmissionRevision: 1, expectedEvidenceHash: workspace.evidence!.hash, course1: "가".repeat(400), course2: "A".repeat(300), notes: "합성 검증: 미접수 답안은 활용하지 않음", checkedGroups: ["team_plan", "journal", "team_report", "exam"], finalize: true };
  await expect(saveRecordDraft(teacher, owner.id, { ...input, course2: input.course2 + "A" })).rejects.toThrow("1,500");
  await saveRecordDraft(teacher, owner.id, input);
  expect((await getRecordWorkspace(owner, owner.id)).draft).toBeUndefined();
  await db.query("UPDATE experiment_journals SET observations='REVISED_OWNER_OBSERVATION' WHERE student_id=$1", [owner.id]);
  await expect(saveRecordDraft(teacher, owner.id, { ...input, expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  expect((await recordHistory(teacher, owner.id)).drafts).toHaveLength(1);
});
