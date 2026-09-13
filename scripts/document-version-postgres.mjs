// Only a newly created, disposable local PostgreSQL database is used.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, postgresVersion } = await createLocalTestDb("document_versions");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { listDocumentVersions, compareDocumentVersions } = await import("../src/lib/document-version-reader.ts");
const actor = { id: "diff_student", role: "student" }, teacher = { id: "teacher_bootstrap", role: "teacher" };
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log("PASS: " + name); };
try {
  await app.query("UPDATE users SET must_change_password=FALSE WHERE id='teacher_bootstrap'");
  await app.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES('diff_student','합성 학생','diff_student',2026,'student','class_2026_9','unused',FALSE),('diff_former','합성 이전 팀원','diff_former',2026,'student','class_2026_9','unused',FALSE)");
  await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES('diff_team','class_2026_9',901,'합성 비교팀','diff_student')");
  await app.query("INSERT INTO team_members(id,team_id,user_id,status) VALUES('diff_member','diff_team','diff_student','active'),('diff_removed','diff_team','diff_former','inactive')");
  await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES('diff_session','diff_team','PLANNING')");
  const cycle = await ensureInitialCycle(app, "diff_session", teacher.id);
  const scope = { documentType: "plan", documentId: "diff_plan", cycleId: cycle };
  const report = { ...scope, documentType: "report", documentId: "diff_report" };
  await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES('diff_plan','diff_session',$1,$2,'approved')", [cycle, { topic: "현재 저장 주제" }]);
  await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data) VALUES('diff_report','diff_session',$1,$2)", [cycle, { title: "저장 제목", purpose: "이전 통합 값" }]);
  await app.query("INSERT INTO report_fields(report_id,field_key,value) VALUES('diff_report','purpose','필드 우선 값')");
  await app.query("INSERT INTO report_member_roles(report_id,user_id,role_description) VALUES('diff_report','diff_former','이전 팀원의 역할')");
  for (let i = 0; i < 65; i++) await app.query("INSERT INTO document_revisions(id,document_type,document_id,cycle_id,snapshot,action,changed_by,created_at) VALUES($1,'plan','diff_plan',$2,$3,'field:topic','diff_student',$4)", [
    "diff_rev_" + String(i).padStart(3, "0"), cycle, { formData: { topic: "과거 주제 " + i }, reviewStatus: "draft", teacherFeedback: "" }, "2026-09-01T00:00:00.000123Z"
  ]);
  const ref = id => ({ kind: "revision", id }), current = { kind: "current" };
  const snapshot = async () => {
    const result = {};
    for (const table of ["investigation_plans", "reports", "report_fields", "report_member_roles", "document_revisions", "plan_submissions", "inquiry_cycles"]) result[table] = (await app.query("SELECT * FROM " + table + " ORDER BY 1")).rows;
    return JSON.stringify(result);
  };
  const before = await snapshot();
  await check("past/past and current/past are independent", async () => {
    const past = await compareDocumentVersions(actor, scope, ref("diff_rev_001"), ref("diff_rev_002"));
    assert.equal(past.a.values.topic, "과거 주제 1"); assert.equal(past.b.values.topic, "과거 주제 2");
    const mixed = await compareDocumentVersions(actor, scope, current, ref("diff_rev_001"));
    assert.equal(mixed.a.values.topic, "현재 저장 주제");
    await assert.rejects(compareDocumentVersions(actor, scope, current, ref("diff_rev_001"), { a: "0".repeat(64) }), e => e.status === 409);
  });
  await check("cursor retains all 65 equal microsecond timestamps without duplicates", async () => {
    const ids = []; let cursor;
    do { const page = await listDocumentVersions(actor, scope, { cursor }); ids.push(...page.history.map(v => v.ref.id)); cursor = page.nextCursor; } while (cursor);
    assert.equal(ids.length, 65); assert.equal(new Set(ids).size, 65);
    const page = await listDocumentVersions(actor, scope);
    await assert.rejects(listDocumentVersions(actor, scope, { cursor: page.nextCursor, fromDate: "2026-09-01" }), e => e.status === 400);
    assert.equal((await listDocumentVersions(actor, scope, { fromDate: "2026-09-02" })).history.length, 0);
    await assert.rejects(listDocumentVersions(actor, scope, { fromDate: "2026-02-30" }), e => e.status === 400);
  });
  await check("report field precedence and removed-member identity are retained", async () => {
    const pair = await compareDocumentVersions(actor, report, current, current);
    assert.equal(pair.a.values.purpose, "필드 우선 값"); assert.equal(pair.a.values.title, "저장 제목");
    assert.equal(pair.a.roles[0].userId, "diff_former");
    assert.equal(pair.a.roles[0].description, "이전 팀원의 역할");
  });
  await check("document/cycle substitution and removed student are denied", async () => {
    await assert.rejects(compareDocumentVersions(actor, report, ref("diff_rev_001"), current), e => e.status === 404);
    await assert.rejects(listDocumentVersions(actor, { ...scope, cycleId: "other" }), e => e.status === 404);
    await assert.rejects(listDocumentVersions({ id: "diff_former", role: "student" }, scope), e => e.status === 404);
  });
  await check("all read operations leave stored documents, roles, revisions and submissions unchanged", async () => assert.equal(await snapshot(), before));
  await check("archived team retains teacher read but blocks student", async () => {
    await app.query("UPDATE teams SET status='archived' WHERE id='diff_team'");
    await assert.rejects(listDocumentVersions(actor, scope), e => e.status === 404);
    assert.equal((await listDocumentVersions(teacher, scope)).history.length, 30);
    await app.query("UPDATE teams SET status='active' WHERE id='diff_team'");
  });
  await check("report stage guard applies to active cycle", async () => {
    await app.query("UPDATE investigation_plans SET review_status='draft' WHERE id='diff_plan'");
    await assert.rejects(listDocumentVersions(actor, report), e => e.status === 404);
    await app.query("UPDATE investigation_plans SET review_status='approved' WHERE id='diff_plan'");
  });
  await check("completed current cycle resolves final and rejects current alias", async () => {
    await app.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1", [cycle]);
    const final = await compareDocumentVersions(actor, scope, { kind: "cycle_final" }, ref("diff_rev_001"));
    assert.equal(final.a.values.topic, "현재 저장 주제");
    await assert.rejects(compareDocumentVersions(actor, scope, current, ref("diff_rev_001")), e => e.status === 404);
  });
  await check("after next cycle starts, final is resolved exclusively from matching completion record", async () => {
    await app.query("INSERT INTO document_revisions(id,document_type,document_id,cycle_id,snapshot,action,changed_by) VALUES('diff_final','plan','diff_plan',$1,$2,'cycle_completed','diff_student')", [cycle, { formData: { topic: "최종 보존" } }]);
    await app.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status) VALUES('diff_next','diff_session',2,'다음 회차','active')");
    await app.query("UPDATE investigation_plans SET cycle_id='diff_next',form_data=$1,review_status='draft' WHERE id='diff_plan'", [{ topic: "다음 회차 내용" }]);
    const pair = await compareDocumentVersions(actor, scope, { kind: "cycle_final" }, ref("diff_rev_001"));
    assert.equal(pair.a.values.topic, "최종 보존");
    assert.equal(pair.a.sourceKey, "revision:diff_final");
  });
  await check("malformed snapshot remains inspectable and is never treated as an empty document", async () => {
    await app.query("UPDATE document_revisions SET snapshot=$1 WHERE id='diff_rev_001'", [JSON.stringify("broken synthetic source")]);
    const pair = await compareDocumentVersions(actor, scope, ref("diff_rev_001"), ref("diff_rev_002"));
    assert.equal(pair.a.valid, false); assert.equal(pair.a.unreadableSource, "broken synthetic source");
  });
  // Pause after reading A, then revoke membership. The final authorization check
  // must discard both bodies even though the repeatable-read snapshot still permits access.
  await check("membership revoked during a read discards the completed result", async () => {
    const originalConnect = app.connect.bind(app);
    let used = false;
    app.connect = async () => {
      const client = await originalConnect(), query = client.query.bind(client), release = client.release.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        if (!used && String(args[0]).includes("SELECT dr.id, dr.action, dr.snapshot")) {
          used = true; const other = await originalConnect();
          try { await other.query("UPDATE team_members SET status='inactive' WHERE id='diff_member'"); } finally { other.release(); }
        }
        return result;
      };
      client.release = () => { client.query = query; client.release = release; release(); };
      return client;
    };
    try { await assert.rejects(compareDocumentVersions(actor, scope, ref("diff_rev_001"), ref("diff_rev_002")), e => e.status === 404); }
    finally { app.connect = originalConnect; }
  });
  await writeFile(new URL("document-version-postgres.json", root), JSON.stringify({ passed, postgresVersion, syntheticOnly: true, checkedAt: new Date().toISOString() }, null, 2));
} finally { await app.end(); }
