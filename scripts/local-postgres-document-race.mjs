// Real app services, independent PostgreSQL connections, synthetic local data only.
// Run: node --experimental-transform-types --import ./scripts/local-ts-loader.mjs scripts/local-postgres-document-race.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), ssl: false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 20000 };
for (const key of ["DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[key] = "";
const database = `codex_validation_documents_${Date.now()}_${randomBytes(4).toString("hex")}`;
const admin = new pg.Pool({ ...config, database: "postgres" });
let app, observer;
const results = [];
const requestedOperations = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",");
try {
  const identity = (await admin.query("SELECT current_user AS actor, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416);
  assert.ok(identity.version >= 160000 && identity.version < 170000);
  assert.match(database, /^codex_validation_documents_[0-9]+_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE "${database}"`);
  process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(config.password)}@127.0.0.1:55416/${database}?options=-c%20statement_timeout%3D20000`;
  process.env.NODE_ENV = "test";
  process.env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-document-race-only";
  const { getDb } = await import("../src/lib/db/index.ts");
  const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
  const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");
  const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
  const { saveReportField, submitReport, reviewReport } = await import("../src/lib/report-service.ts");
  const { savePlanField, submitPlan, reviewPlan } = await import("../src/lib/plan-service.ts");
  const { saveStudentJournal } = await import("../src/lib/journal-service.ts");
  const { REPORT_FIELDS } = await import("../src/lib/constants.ts");
  const { saveAndSyncMaterials } = await import("../src/lib/materials.ts");
  const { saveDiscussionEntry, confirmMeeting } = await import("../src/lib/discussions.ts");
  const { restorePlanRevision, restoreReportRevision } = await import("../src/lib/document-history.ts");
  app = await getDb(); observer = new pg.Pool({ ...config, database });
  const nativeConnect = app.connect.bind(app);
  let gate = null;
  // Instrument only the returned real connection. SQL and transaction behavior
  // remain PostgreSQL's; the pause chooses a deterministic interleaving.
  app.connect = (...connectArgs) => {
    // Pool.query uses callback-style connect internally; preserve that API.
    if (connectArgs.length) return nativeConnect(...connectArgs);
    return (async () => {
    const client = await nativeConnect();
    const nativeQuery = client.query.bind(client), nativeRelease = client.release.bind(client);
    client.query = async (...args) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      const selected = gate && !gate.used && gate.matches(sql);
      if (selected) {
        const current = gate; current.used = true;
        current.pid = client.processID; current.reached();
        await current.proceed;
      }
      return nativeQuery(...args);
    };
    client.release = (...args) => { client.query = nativeQuery; return nativeRelease(...args); };
    return client;
    })();
  };
  function pause(matches) {
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; });
    const proceed = new Promise(resolve => { resume = resolve; });
    gate = { matches, reached, proceed, used: false, pid: null };
    return { ready, resume, state: gate };
  }
  async function waitBlocked(pid) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const waiting = (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid))", [database, pid])).rows;
      if (waiting.length) return waiting[0].pid;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Expected independent app connection to wait on the first transaction");
  }
  const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  const syntheticAnalysis = async () => ({ model: "synthetic-no-network", result: {
    overview: "합성 자료 검증", inquiryField: "화학", researchType: "비교 실험", strengths: [], findings: [],
    suggestions: [{ title: "측정 확인", rationale: "계획의 주제를 확인한다.", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격을 정한다.", safetyNote: "보호 장비를 확인한다.", questionForStudents: "측정 간격은?" }], cycleComparison: [], limitations: [],
  } });
  for (const operation of ["report_save", "plan_save", "report_restore", "plan_restore", "report_submit", "report_review", "plan_review", "plan_submit", "journal_save", "material_save", "analysis_overlap", "analysis_takeover", "discussion_peer", "discussion_meeting", "discussion_confirm", "material_race_reproduction", "discussion_race_reproduction"]) {
  if (operation.endsWith("race_reproduction") && !requestedOperations?.includes(operation)) continue;
  if (requestedOperations && !requestedOperations.includes(operation)) continue;
  for (const action of ["start_next", "finish_project"]) {
    for (const first of ["transition", "save"]) {
      if ((operation.endsWith("race_reproduction") || operation.startsWith("analysis_")) && first === "save") continue;
      const key = `${operation}_${action}_${first}`, team = `team_${key}`, session = `session_${key}`, plan = `plan_${key}`, report = `report_${key}`;
      await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 경합팀','demo_student_1')", [team, results.length + 100]);
      await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
      await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
      const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
      await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [plan, session, cycle, { topic: "합성 측정", method: "같은 간격으로 측정한다." }]);
      await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [report, session, cycle, { title: "합성 측정", analysis: "변경 전 결과" }]);
      const isPlan = operation.startsWith("plan_"), isRestore = operation.endsWith("_restore"), revision = `revision_${key}`;
      const isReview = operation.endsWith("_review"), isSubmit = operation.endsWith("_submit");
      const isJournal = operation === "journal_save";
      const isMaterial = operation === "material_save";
      const isDiscussion = ["discussion_peer", "discussion_meeting", "discussion_confirm"].includes(operation);
      const discussionActor = { id: "demo_student_1", role: "student", mustChangePassword: false };
      if (operation === "discussion_confirm") await saveDiscussionEntry(discussionActor, { id: `entry_${key}`, sessionId: session, cycleId: cycle, kind: "meeting", date: "2026-09-08", content: "합성 기존 대면 기록", participantIds: ["demo_student_1"] });
      if (isMaterial) await app.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
      if (isJournal) {
        await app.query("INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,sync_status) VALUES($1,$1,$2,$3,$4,'demo_student_1',$5,'synced')", [`material_${key}`, session, cycle, team, JSON.stringify([{ name: "합성 비커", quantity: 1, unitPrice: 0, shipping: 0 }])]);
      }
      if (isSubmit && isPlan) {
        await app.query("UPDATE investigation_plans SET form_data=$1 WHERE id=$2", [{ field: "화학", topic: "합성 측정", motivation: "합성 동기", purpose: "합성 목적", method: "같은 간격으로 측정한다.", expectedResult: "합성 예상 결과" }, plan]);
      }
      if (isSubmit && !isPlan) {
        await app.query("UPDATE reports SET form_data=$1 WHERE id=$2", [{ ...Object.fromEntries(REPORT_FIELDS.map(field => [field.key, "합성 검증 내용"])), title: "합성 측정", analysis: "변경 전 결과" }, report]);
        await app.query("INSERT INTO report_member_roles(report_id,user_id,role_description) VALUES($1,'demo_student_1','합성 측정 담당')", [report]);
      }
      if (isRestore) {
        await app.query("INSERT INTO document_revisions(id,document_type,document_id,cycle_id,snapshot,action,changed_by) VALUES($1,$2,$3,$4,$5,'synthetic_previous','teacher_bootstrap')", [revision, isPlan ? "plan" : "report", isPlan ? plan : report, cycle, isPlan
          ? { formData: { topic: "합성 이전 주제", method: "이전 실험 방법" }, reviewStatus: "draft", teacherFeedback: null }
          : { formData: { title: "합성 측정", analysis: "이전 보고서 결과" }, status: "draft", teacherFeedback: null, roles: [{ userId: "demo_student_2", description: "이전 참여자의 역할" }] }]);
      }
      if (operation.startsWith("analysis_")) {
        const firstType = action === "start_next" ? "intermediate" : "final", otherType = firstType === "intermediate" ? "final" : "intermediate";
        let markReady, release;
        const ready = new Promise(resolve => { markReady = resolve; }), resume = new Promise(resolve => { release = resolve; });
        let firstCalls = 0, otherCalls = 0;
        const firstResult = settle(requestCycleAnalysis(cycle, firstType, "teacher_bootstrap", async () => { firstCalls++; markReady(); await resume; return syntheticAnalysis(); }));
        const otherGenerate = async () => { otherCalls++; return syntheticAnalysis(); };
        const timer = setTimeout(release, 15000);
        let winner;
        try {
          await Promise.race([ready, firstResult.then(result => { throw result.error ?? new Error("Analysis finished before generation pause"); })]);
          if (operation === "analysis_overlap") {
            await assert.rejects(requestCycleAnalysis(cycle, otherType, "teacher_bootstrap", otherGenerate), /분석 중/);
            assert.equal(otherCalls, 0);
          } else {
            // Advance only the synthetic lease, without waiting thirty minutes.
            await app.query("UPDATE ai_generation_jobs SET lease_until='2026-01-01T00:00:00Z' WHERE resource_key=$1 AND status='processing'", [`cycle-analysis:${cycle}`]);
            winner = await requestCycleAnalysis(cycle, otherType, "teacher_bootstrap", otherGenerate);
          }
        } finally { clearTimeout(timer); release(); }
        const firstOutcome = await firstResult;
        assert.equal(firstCalls, 1);
        if (operation === "analysis_takeover") {
          assert.equal(firstOutcome.ok, false); assert.match(firstOutcome.error.message, /소유권|최종 분석/);
          const rows = (await app.query("SELECT analysis_type FROM cycle_ai_analyses WHERE cycle_id=$1", [cycle])).rows;
          assert.deepEqual(rows, [{ analysis_type: otherType }]);
          assert.equal((await requestCycleAnalysis(cycle, otherType, "teacher_bootstrap", otherGenerate)).id, winner.id);
          assert.equal(otherCalls, 1);
        } else {
          assert.equal(firstOutcome.ok, true, firstOutcome.error?.message);
          if (firstType === "intermediate") {
            winner = await requestCycleAnalysis(cycle, "final", "teacher_bootstrap", otherGenerate);
            assert.equal(otherCalls, 1);
          } else winner = firstOutcome.value;
          await assert.rejects(requestCycleAnalysis(cycle, "intermediate", "teacher_bootstrap", otherGenerate), /최종 분석/);
          assert.equal((await requestCycleAnalysis(cycle, "final", "teacher_bootstrap", otherGenerate)).id, winner.id);
          assert.equal(otherCalls, firstType === "intermediate" ? 1 : 0);
        }
        results.push({ operation, firstType, otherType, firstCalls, otherCalls, cachedWinnerPreserved: true });
        console.log(`${operation}_${firstType}: passed`);
        continue;
      }
      await requestCycleAnalysis(cycle, action === "start_next" ? "intermediate" : "final", "teacher_bootstrap", syntheticAnalysis);
      const move = () => transitionCycle({ cycleId: cycle, action, teacherId: "teacher_bootstrap" });
      if (operation.endsWith("race_reproduction")) {
        // Reproduction of the pre-fix race, not a passing acceptance criterion.
        await app.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
        const paused = pause(sql => sql.includes("UPDATE inquiry_cycles SET status = 'completed'"));
        const moving = settle(move());
        const timer = setTimeout(paused.resume, 12000);
        try {
          await Promise.race([paused.ready, moving.then(result => { throw result.error ?? new Error("Transition ended before pause"); })]);
          if (operation === "material_race_reproduction") {
            const saved = await saveAndSyncMaterials({ submissionId: `submission_${key}`, sessionId: session, teamId: team, actorId: "demo_student_1", items: [{ name: "합성 비커", specification: "", quantity: 1, unitPrice: 0, shipping: 0, link: "" }] });
            assert.equal(saved.syncStatus, "pending");
          } else await saveDiscussionEntry({ id: "demo_student_1", role: "student", mustChangePassword: false }, { id: `entry_${key}`, sessionId: session, kind: "peer", content: "합성 늦은 메시지" });
        } finally { clearTimeout(timer); paused.resume(); }
        const moved = await moving; assert.equal(moved.ok, true, moved.error?.message); gate = null;
        if (operation === "material_race_reproduction") {
          const rows = (await app.query("SELECT c.status,mr.sync_status FROM material_requests mr JOIN inquiry_cycles c ON c.id=mr.cycle_id WHERE mr.session_id=$1", [session])).rows;
          assert.deepEqual(rows, [{ status: "completed", sync_status: "pending" }]);
        } else {
          const rows = (await app.query("SELECT c.status,de.content FROM discussion_entries de JOIN inquiry_cycles c ON c.id=de.cycle_id WHERE de.session_id=$1", [session])).rows;
          assert.deepEqual(rows, [{ status: "completed", content: "합성 늦은 메시지" }]);
        }
        results.push({ operation, action, reproduced: true, completedCycleReceivedLateWrite: true });
        console.log(`${key}: race reproduced (not acceptance)`);
        continue;
      }
      const save = () => isDiscussion
        ? operation === "discussion_confirm" ? confirmMeeting(discussionActor, session, `entry_${key}`, cycle) : saveDiscussionEntry(discussionActor, { id: `entry_${key}`, sessionId: session, cycleId: cycle, kind: operation === "discussion_peer" ? "peer" : "meeting", date: "2026-09-08", content: "합성 새 대화", participantIds: ["demo_student_1"] })
        : isMaterial
        ? saveAndSyncMaterials({ submissionId: `submission_${key}`, sessionId: session, cycleId: cycle, teamId: team, actorId: "demo_student_1", items: [{ name: "합성 비커", specification: "", quantity: 1, unitPrice: 0, shipping: 0, link: "" }] })
        : isJournal
        ? saveStudentJournal({ id: "demo_student_1", role: "student" }, { sessionId: session, cycleId: cycle, sessionNumber: 1, date: "2026-09-08", activities: "합성 측정 활동", observations: "합성 관찰", reflections: "합성 개인 성찰", expectedVersion: null, existingImageIds: [], photos: [] })
        : isReview
        ? (isPlan ? reviewPlan(plan, "teacher_bootstrap", "feedback", "합성 수정 요청", "9반 합성 경합팀", { submissionId: null, cycleId: cycle, status: "approved", feedback: "" }) : reviewReport(report, "teacher_bootstrap", "feedback", "합성 수정 요청", { cycleId: cycle, version: 0, status: "reviewed", feedback: "" }))
        : isSubmit ? (isPlan ? submitPlan(plan, "demo_student_1", cycle) : submitReport(report, "demo_student_1", cycle))
        : isRestore
        ? (isPlan ? restorePlanRevision(plan, revision, "teacher_bootstrap", cycle) : restoreReportRevision(report, revision, "teacher_bootstrap", cycle))
        : (isPlan ? savePlanField(plan, "method", "변경 후 실험 방법", "demo_student_1", "같은 간격으로 측정한다.", cycle) : saveReportField(report, "analysis", "변경 후 결과", "demo_student_1", "변경 전 결과", cycle));
      const paused = pause(sql => first === "transition" ? sql.includes("UPDATE inquiry_cycles SET status = 'completed'") : isDiscussion ? sql.includes(operation === "discussion_confirm" ? "INSERT INTO discussion_confirmations" : "INSERT INTO discussion_entries") : isMaterial ? sql.includes("INSERT INTO material_requests") : isJournal ? sql.includes("INSERT INTO experiment_journals") : isPlan ? sql.includes("UPDATE investigation_plans") : sql.includes("UPDATE reports") && sql.includes("write_version"));
      const firstResult = settle(first === "transition" ? move() : save());
      let secondResult, waitingPid;
      const timeout = setTimeout(paused.resume, 12000);
      try {
        await Promise.race([paused.ready, firstResult.then(() => { throw new Error("First operation ended before the intended pause"); })]);
        secondResult = settle(first === "transition" ? save() : move());
        waitingPid = await Promise.race([waitBlocked(paused.state.pid), secondResult.then(result => { throw new Error(`Second operation ended before waiting: ${result.error?.message ?? 'success'}`); })]);
      } finally { clearTimeout(timeout); paused.resume(); }
      const [one, two] = await Promise.all([firstResult, secondResult]);
      gate = null;
      assert.equal(one.ok, true, one.error?.message);
      assert.equal(two.ok, false, "The stale second operation must revalidate after waiting");
      assert.match(two.error.message, first === "transition" ? (isJournal ? /일지|회차/ : /회차|계획서|제출본/) : /자료|계획서|보고서|분석|준비물/);
      const current = (await app.query("SELECT r.cycle_id,r.status,r.form_data,c.status AS cycle_status,s.stage FROM reports r JOIN inquiry_cycles c ON c.id=r.cycle_id JOIN inquiry_sessions s ON s.id=r.session_id WHERE r.id=$1", [report])).rows[0];
      const currentPlan = (await app.query("SELECT cycle_id,form_data,review_status FROM investigation_plans WHERE id=$1", [plan])).rows[0];
      const fields = (await app.query("SELECT value FROM report_fields WHERE report_id=$1 AND field_key='analysis'", [report])).rows;
      if (first === "save") {
        assert.equal(current.cycle_id, cycle); assert.equal(current.cycle_status, "active");
        if (isJournal || isMaterial || isDiscussion) {
          assert.equal(current.status, "reviewed"); assert.equal(currentPlan.review_status, "approved");
        } else if (isPlan) {
          assert.equal(currentPlan.cycle_id, cycle); assert.equal(currentPlan.review_status, isSubmit ? "pending" : isReview ? "feedback" : "reapproval_required");
          assert.equal(currentPlan.form_data.method, isReview || isSubmit ? "같은 간격으로 측정한다." : isRestore ? "이전 실험 방법" : "변경 후 실험 방법");
          assert.equal(current.status, "reviewed");
          if (isRestore) assert.equal((await app.query("SELECT selected_topic FROM inquiry_sessions WHERE id=$1", [session])).rows[0].selected_topic, "합성 이전 주제");
        } else {
          assert.equal(current.status, isReview ? "feedback" : isSubmit ? "submitted" : "draft");
          if (isReview || isSubmit) { assert.equal(current.form_data.analysis, "변경 전 결과"); assert.equal(fields.length, 0); }
          else if (isRestore) {
            assert.equal(current.form_data.analysis, "이전 보고서 결과"); assert.equal(fields.length, 0);
            assert.deepEqual((await app.query("SELECT user_id,role_description FROM report_member_roles WHERE report_id=$1", [report])).rows, [{ user_id: "demo_student_2", role_description: "이전 참여자의 역할" }]);
          } else assert.equal(fields[0]?.value, "변경 후 결과");
        }
      } else if (action === "start_next") {
        assert.notEqual(current.cycle_id, cycle); assert.deepEqual(current.form_data, {}); assert.equal(fields.length, 0);
        assert.equal(currentPlan.cycle_id, current.cycle_id); assert.deepEqual(currentPlan.form_data, {});
        const old = (await app.query("SELECT snapshot FROM document_revisions WHERE document_id=$1 AND cycle_id=$2 AND action='cycle_completed'", [report, cycle])).rows;
        assert.equal(old.length, 1); assert.equal(old[0].snapshot.formData.analysis, "변경 전 결과");
        const oldPlan = (await app.query("SELECT snapshot FROM document_revisions WHERE document_id=$1 AND cycle_id=$2 AND action='cycle_completed'", [plan, cycle])).rows;
        assert.equal(oldPlan.length, 1); assert.equal(oldPlan[0].snapshot.formData.method, "같은 간격으로 측정한다.");
      } else {
        assert.equal(current.cycle_status, "completed"); assert.equal(current.stage, "COMPLETED");
        assert.equal(current.form_data.analysis, "변경 전 결과"); assert.equal(fields.length, 0);
        assert.equal(currentPlan.form_data.method, "같은 간격으로 측정한다."); assert.equal(currentPlan.review_status, "approved");
      }
      if (isReview) {
        const notices = (await app.query("SELECT content,team_id FROM notices WHERE source_id=$1 AND kind='action_request'", [isPlan ? plan : report])).rows;
        assert.deepEqual(notices, first === "save" ? [{ content: "합성 수정 요청", team_id: team }] : []);
      }
      if (isJournal) {
        const journals = (await app.query("SELECT cycle_id,activities,observations,reflections FROM experiment_journals WHERE session_id=$1", [session])).rows;
        assert.deepEqual(journals, first === "save" ? [{ cycle_id: cycle, activities: "합성 측정 활동", observations: "합성 관찰", reflections: "합성 개인 성찰" }] : []);
      }
      if (isMaterial) {
        const materials = (await app.query("SELECT cycle_id,sync_status FROM material_requests WHERE session_id=$1", [session])).rows;
        assert.deepEqual(materials, first === "save" ? [{ cycle_id: cycle, sync_status: "pending" }] : []);
      }
      if (isDiscussion) {
        const entries = (await app.query("SELECT content,cycle_id FROM discussion_entries WHERE session_id=$1", [session])).rows;
        assert.deepEqual(entries, operation === "discussion_confirm" ? [{ content: "합성 기존 대면 기록", cycle_id: cycle }] : first === "save" ? [{ content: "합성 새 대화", cycle_id: cycle }] : []);
        assert.equal((await app.query("SELECT entry_id FROM discussion_confirmations WHERE entry_id=$1", [`entry_${key}`])).rows.length, operation === "discussion_confirm" && first === "save" ? 1 : 0);
      }
      if (isPlan && isSubmit) {
        const submissions = (await app.query("SELECT cycle_id,review_status FROM plan_submissions WHERE plan_id=$1", [plan])).rows;
        assert.deepEqual(submissions, first === "save" ? [{ cycle_id: cycle, review_status: "pending" }] : []);
      }
      results.push({ operation, action, first, blocked: waitingPid !== paused.state.pid, secondRejected: true, originalCyclePreserved: true });
      console.log(`${key}: passed`);
    }
  }
  }
  if (requestedOperations) assert.deepEqual([...new Set(results.map(item => item.operation))].sort(), [...requestedOperations].sort());
  await writeFile(new URL(requestedOperations ? `postgres-document-race-${requestedOperations.join("-")}.json` : "postgres-document-race.json", root), JSON.stringify({ database, postgresVersion: identity.version, results }, null, 2));
} finally { await app?.end(); await observer?.end(); await admin.end(); }
