import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const password = (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim();
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password, ssl: false };
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const key = "backup_restore_fixture", sender = `${key}_a`, reader = `${key}_b`;
const actor = { id: sender, role: "student", mustChangePassword: false };
async function run(binary, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(`Synthetic subprocess failed (${code}): ${output}`)));
  });
}
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(value).digest("hex");
async function inventory(pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
    const rows = (await pool.query(`SELECT to_jsonb(t) AS row FROM public."${tablename}" t`)).rows.map(row => stable(row.row)).sort();
    result[tablename] = { count: rows.length, hash: digest(JSON.stringify(rows)), rows };
  }
  return result;
}
async function structure(pool) {
  const definitions = {
    columns: "SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default,character_maximum_length,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
    constraints: "SELECT rel.relname,c.conname,c.contype,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname='public' ORDER BY rel.relname,c.conname",
    indexes: "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
    sequences: "SELECT * FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
    functions: "SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY p.proname,definition",
    triggers: "SELECT rel.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class rel ON rel.oid=t.tgrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY rel.relname,t.tgname",
    views: "SELECT viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname",
  };
  const result = {};
  for (const [name, sql] of Object.entries(definitions)) result[name] = (await pool.query(sql)).rows;
  return result;
}
if (process.argv.includes("--boot") || process.argv.includes("--write")) {
  const database = process.argv.at(-1);
  assert.match(database, /^codex_validation_restored_[0-9]+_[a-f0-9]+$/);
  for (const name of ["INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SPREADSHEET_ID", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[name] = "";
  process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(password)}@127.0.0.1:55416/${database}`;
  process.env.NODE_ENV = "test";
  const { getDb } = await import("../src/lib/db/index.ts");
  const app = await getDb();
  try {
    assert.equal((await app.query("SELECT current_database() AS name")).rows[0].name, database);
    const { getPublishedStudentExamResult } = await import("../src/lib/exam-service.ts");
    const { getStudentEvaluationData } = await import("../src/lib/evaluation-service.ts");
    assert.ok(await getPublishedStudentExamResult(sender, key));
    assert.ok((await getStudentEvaluationData(sender, key)).result);
    if (process.argv.includes("--write")) {
      const { saveDiscussionEntry } = await import("../src/lib/discussions.ts");
      await saveDiscussionEntry(actor, { id: "backup_restored_new_message", sessionId: key, kind: "peer", content: "복원 후 합성 저장 확인" });
    }
    console.log("Restored app checks passed");
  } finally { await app.end(); }
} else {
  const { app, database, postgresVersion } = await createLocalTestDb("backup");
  let restored, admin;
  try {
    const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
    const { saveDiscussionEntry, markDiscussionMessagesRead } = await import("../src/lib/discussions.ts");
    const { removeStudent } = await import("../src/lib/teams.ts");
    const exam = await import("../src/lib/exam-service.ts");
    const evaluation = await import("../src/lib/evaluation-service.ts");
    for (const id of [sender, reader]) await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 복원 학생',$1,2026,'student','class_2026_4','unused',FALSE)", [id]);
    await app.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_4',101,'합성 복원팀')", [key]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
    for (const id of [sender, reader]) await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
    const cycle = await ensureInitialCycle(app, key, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')", [key, cycle, JSON.stringify({ topic: "복원용 합성 탐구", method: "고정 계획 원문" })]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$1,$2,$3,'reviewed')", [key, cycle, JSON.stringify({ analysis: "고정 보고 원문" })]);
    await app.query("INSERT INTO report_member_roles(report_id,user_id,role_description) VALUES($1,$2,'제거 전 합성 역할')", [key, reader]);
    await app.query("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES($1,$2,'https://push.example/backup','synthetic-key','synthetic-auth')", [key, reader]);
    await saveDiscussionEntry(actor, { id: key, sessionId: key, cycleId: cycle, kind: "peer", content: "백업할 합성 원문" });
    await markDiscussionMessagesRead({ ...actor, id: reader }, key, cycle, [key]);
    const generator = { generateCommon: async () => [{ stimulus: "합성 자료", question: "합성 질문", competency: "해석", difficulty: "standard", modelAnswer: "합성 답", rubric: [{ criterion: "근거", points: 1 }], sourceKeys: [] }], generateTeam: async () => ({ teamQuestions: [], individualQuestions: [] }) };
    const examId = await exam.generateExamSet("teacher_bootstrap", { classNumber: 4, title: "합성 복원 시험", commonCount: 1, teamCount: 0, individualCount: 0, totalScore: 1, commonScope: "합성" }, generator);
    await exam.confirmExamSet("teacher_bootstrap", examId);
    const data = (await exam.getExamManagementData(4, examId)).selected;
    const paper = data.papers.find(row => row.studentId === sender);
    await exam.saveExamResult("teacher_bootstrap", { examId: paper.examId, questionScores: { [data.questions[0].id]: 1 }, teacherFeedback: "합성 확정 결과" });
    await exam.publishExamResult("teacher_bootstrap", paper.examId);
    await removeStudent("teacher_bootstrap", reader, key);
    const round = await evaluation.createEvaluationRound("teacher_bootstrap", { classNumber: 4, title: "합성 복원 평가", optionalItem: "none" });
    await evaluation.changeEvaluationRoundStatus("teacher_bootstrap", round, "open");
    await evaluation.changeEvaluationRoundStatus("teacher_bootstrap", round, "close");
    await evaluation.saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: round, studentId: sender, teacherSummary: "보존할 공개 피드백", expectedVersion: null });
    await evaluation.publishEvaluationRound("teacher_bootstrap", round);
    const before = await inventory(app);
    const schemaBefore = await structure(app);
    for (const table of ["plan_document_snapshots", "plan_submissions", "document_revisions", "report_member_roles", "exam_sets", "exam_questions", "exams", "evaluation_publications", "discussion_entries", "discussion_message_recipients", "discussion_push_outbox", "schema_migrations"]) assert.ok(before[table]?.count > 0, `${table} must be populated`);
    const backup = new URL(`backup-63-${database}.dump`, root);
    const args = ["--host=127.0.0.1", "--port=55416", "--username=codex_local", "--no-password"];
    await run(fileURLToPath(new URL("postgres16/pgsql/bin/pg_dump.exe", root)), [...args, "--format=custom", `--file=${fileURLToPath(backup)}`, database], { ...process.env, PGPASSWORD: password });
    const target = `codex_validation_restored_${Date.now()}_${randomBytes(4).toString("hex")}`;
    admin = new pg.Pool({ ...config, database: "postgres" });
    await admin.query(`CREATE DATABASE "${target}"`);
    await run(fileURLToPath(new URL("postgres16/pgsql/bin/pg_restore.exe", root)), [...args, "--exit-on-error", "--single-transaction", `--dbname=${target}`, fileURLToPath(backup)], { ...process.env, PGPASSWORD: password });
    restored = new pg.Pool({ ...config, database: target });
    assert.deepEqual(await inventory(restored), before);
    assert.deepEqual(await structure(restored), schemaBefore);
    const childArgs = ["--experimental-transform-types", "--import", "./scripts/local-review-test-loader.mjs", fileURLToPath(import.meta.url)];
    await run(process.execPath, [...childArgs, "--boot", target]);
    assert.deepEqual(await inventory(restored), before);
    assert.deepEqual(await structure(restored), schemaBefore);
    await run(process.execPath, [...childArgs, "--write", target]);
    const afterWrite = await inventory(restored);
    const mutable = new Set(["inquiry_sessions", "cycle_discussion_days", "discussion_entries", "discussion_message_recipients", "discussion_push_outbox", "audit_logs"]);
    for (const [table, rows] of Object.entries(before)) {
      if (!mutable.has(table)) assert.deepEqual(afterWrite[table], rows, `Unexpected write in ${table}`);
      else if (!["inquiry_sessions", "cycle_discussion_days"].includes(table)) for (const row of rows.rows) assert.ok(afterWrite[table].rows.includes(row), `Historical row changed in ${table}`);
    }
    assert.equal((await restored.query("SELECT content FROM discussion_entries WHERE id='backup_restored_new_message'")).rows[0].content, "복원 후 합성 저장 확인");
    assert.deepEqual(await inventory(app), before);
    assert.deepEqual(await structure(app), schemaBefore);
    await writeFile(new URL("postgres-backup-restore-63.json", root), JSON.stringify({ source: database, restored: target, postgresVersion, backupFile: fileURLToPath(backup), backupSha256: digest(await readFile(backup)), structure: Object.fromEntries(Object.entries(schemaBefore).map(([name, rows]) => [name, { count: rows.length, hash: digest(stable(rows)) }])), tables: Object.fromEntries(Object.entries(before).map(([name, row]) => [name, { count: row.count, hash: row.hash }])), restoreExact: true, structureExact: true, appBootstrapPreserved: true, restoredReadsAndWritePassed: true, sourceUnchanged: true }, null, 2));
    console.log(JSON.stringify({ tablesCompared: Object.keys(before).length, restoreExact: true, appReadsAndWritePassed: true, sourceUnchanged: true }));
  } finally { await restored?.end(); await admin?.end(); await app.end(); }
}
