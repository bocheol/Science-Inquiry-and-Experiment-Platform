// Actual local PostgreSQL/services, synthetic documents and injected analysis only.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("positive_review");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");
const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const { savePlanField, submitPlan, reviewPlan } = await import("../src/lib/plan-service.ts");
const { saveReportField, submitReport, reviewReport } = await import("../src/lib/report-service.ts");
const { getLatestPlanSubmission } = await import("../src/lib/plan-snapshots.ts");
const { PLAN_FIELDS, REPORT_FIELDS } = await import("../src/lib/constants.ts");
const generate = async () => ({ model: "synthetic", result: { overview: "합성 승인 검증", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "측정 기록", rationale: "자료 비교", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격 비교", safetyNote: "", questionForStudents: "어떤 조건인가요?" }] } });
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const results = [];
const studentMode = process.argv.includes("--student-writes");
let gate;
const connect = app.connect.bind(app);
app.connect = (...args) => args.length ? connect(...args) : (async () => {
  const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
  client.query = async (...queryArgs) => {
    const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0].text;
    if (gate && !gate.used && gate.match(sql)) {
      const selected = gate; selected.used = true; selected.pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      selected.reached(); await selected.pause;
    }
    return query(...queryArgs);
  };
  client.release = (...releaseArgs) => { client.query = query; client.release = release; return release(...releaseArgs); };
  return client;
})();
async function waitBlocked(blocker) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [blocker])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("No database lock wait observed");
}
try {
  for (const document of ["plan", "report"]) for (const action of studentMode ? ["edit", "resubmit"] : ["start_next", "finish_project"]) for (const first of studentMode ? ["student", "review"] : ["transition", "review"]) {
    const key = `${document}_${action}_${first}`, team = `team_${key}`, session = `session_${key}`, plan = `plan_${key}`, report = `report_${key}`;
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 승인팀','demo_student_1')", [team, 700 + results.length]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    const planData = { ...Object.fromEntries(PLAN_FIELDS.map(field => [field.key, "합성 기존 내용"])), topic: "합성 측정", method: "기존 방법" };
    const reportData = { ...Object.fromEntries(REPORT_FIELDS.map(field => [field.key, "합성 기존 내용"])), title: "합성 측정", analysis: "기존 결과" };
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [plan, session, cycle, planData]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [report, session, cycle, reportData]);
    await app.query("INSERT INTO report_member_roles(report_id,user_id,role_description) VALUES($1,'demo_student_1','합성 측정 담당')", [report]);
    const type = action === "start_next" ? "intermediate" : "final";
    if (!studentMode) await requestCycleAnalysis(cycle, type, "teacher_bootstrap", generate);
    if (document === "plan") {
      await savePlanField(plan, "method", "재제출한 방법", "demo_student_1", "기존 방법", cycle);
      await submitPlan(plan, "demo_student_1", cycle);
    } else {
      await saveReportField(report, "analysis", "재제출한 결과", "demo_student_1", "기존 결과", cycle);
      await submitReport(report, "demo_student_1", cycle);
    }
    const submission = await getLatestPlanSubmission(app, plan, cycle);
    const reportState = (await app.query("SELECT write_version,status FROM reports WHERE id=$1", [report])).rows[0];
    const planSnapshots = (await app.query("SELECT * FROM plan_document_snapshots WHERE plan_id=$1 ORDER BY id", [plan])).rows;
    const review = () => document === "plan"
      ? reviewPlan(plan, "teacher_bootstrap", "approved", "", "", { cycleId: cycle, submissionId: submission.id, status: "pending", feedback: "" })
      : reviewReport(report, "teacher_bootstrap", "reviewed", "", { cycleId: cycle, version: reportState.write_version, status: reportState.status, feedback: "" });
    const move = () => transitionCycle({ cycleId: cycle, action, teacherId: "teacher_bootstrap" });
    if (studentMode) {
      const write = () => action === "edit"
        ? document === "plan" ? savePlanField(plan, "method", "검토 중 추가 수정", "demo_student_1", "재제출한 방법", cycle) : saveReportField(report, "analysis", "검토 중 추가 수정", "demo_student_1", "재제출한 결과", cycle)
        : document === "plan" ? submitPlan(plan, "demo_student_1", cycle) : submitReport(report, "demo_student_1", cycle);
      let reached, resume;
      const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
      gate = { used: false, reached, pause, match: sql => document === "plan" ? sql.includes("UPDATE investigation_plans") : sql.includes("UPDATE reports") && sql.includes("write_version") };
      const one = settle(first === "student" ? write() : review());
      let two;
      const timer = setTimeout(resume, 15000);
      try {
        await Promise.race([ready, one.then(result => { throw result.error ?? new Error("First write ended before pause"); })]);
        two = settle(first === "student" ? review() : write());
        await Promise.race([waitBlocked(gate.pid), two.then(result => { throw result.error ?? new Error("Second write did not wait"); })]);
      } finally { clearTimeout(timer); resume(); }
      const [a, b] = await Promise.all([one, two]); gate = null;
      const written = first === "student" ? a : b, reviewed = first === "student" ? b : a;
      assert.equal(written.ok, true, written.error?.message);
      assert.equal(reviewed.ok, first === "review", reviewed.error?.message);
      if (!reviewed.ok) assert.match(reviewed.error.message, /변경|제출/);
      const currentPlan = (await app.query("SELECT form_data,review_status FROM investigation_plans WHERE id=$1", [plan])).rows[0];
      const currentReport = (await app.query("SELECT form_data,status FROM reports WHERE id=$1", [report])).rows[0];
      if (document === "plan") {
        const expectedStatus = action === "resubmit" ? "pending" : first === "review" ? "reapproval_required" : "draft";
        assert.equal(currentPlan.review_status, expectedStatus);
        assert.equal(currentPlan.form_data.method, action === "edit" ? "검토 중 추가 수정" : "재제출한 방법");
        const oldSubmission = (await app.query("SELECT review_status FROM plan_submissions WHERE id=$1", [submission.id])).rows[0];
        // Editing withdraws the pending submission. An unchanged resubmission
        // preserves its historical status and creates a distinct latest ID.
        assert.equal(oldSubmission.review_status, first === "review" ? "approved" : action === "edit" ? "withdrawn" : "pending");
        if (action === "resubmit") {
          const latest = await getLatestPlanSubmission(app, plan, cycle);
          assert.notEqual(latest.id, submission.id); assert.equal(latest.reviewStatus, "pending");
        }
      } else {
        assert.equal(currentReport.status, action === "edit" ? "draft" : "submitted");
        const savedField = (await app.query("SELECT value FROM report_fields WHERE report_id=$1 AND field_key='analysis'", [report])).rows[0];
        assert.equal(savedField.value, action === "edit" ? "검토 중 추가 수정" : "재제출한 결과");
      }
      // New submissions may add snapshots, but existing fixed contents must not change.
      for (const snapshot of planSnapshots) assert.deepEqual((await app.query("SELECT * FROM plan_document_snapshots WHERE id=$1", [snapshot.id])).rows[0], snapshot);
      const approvals = (await app.query("SELECT id FROM document_revisions WHERE document_id=$1 AND action=$2", [document === "plan" ? plan : report, document === "plan" ? "teacher_approve" : "teacher_review"])).rows;
      assert.equal(approvals.length, first === "review" ? 1 : 0);
      const state = (await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows;
      const reportStateAfter = (await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows;
      await assert.rejects(review(), /변경|제출/);
      assert.deepEqual((await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows, state);
      assert.deepEqual((await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows, reportStateAfter);
      results.push({ document, action, first, observedLockWait: true, studentWritePreserved: true, approvalSaved: reviewed.ok, reReviewRequired: true, fixedSubmissionsPreserved: true, staleApprovalRejected: true });
      console.log(`${key}: passed`);
      continue;
    }
    let reached, resume;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, match: sql => first === "transition" ? sql.includes("SELECT status FROM inquiry_cycles WHERE id = $1 FOR UPDATE") : document === "plan" ? sql.includes("UPDATE investigation_plans") : sql.includes("UPDATE reports SET status") };
    const one = settle(first === "transition" ? move() : review());
    let two;
    const timer = setTimeout(resume, 15000);
    try {
      await Promise.race([ready, one.then(result => { throw result.error ?? new Error("First operation ended before pause"); })]);
      two = settle(first === "transition" ? review() : move());
      await Promise.race([waitBlocked(gate.pid), two.then(result => { throw result.error ?? new Error("Second operation did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const [a, b] = await Promise.all([one, two]); gate = null;
    const transitioned = first === "transition" ? a : b, reviewed = first === "transition" ? b : a;
    assert.equal(reviewed.ok, true, reviewed.error?.message);
    assert.equal(transitioned.ok, false); assert.match(transitioned.error.message, /자료|계획서|보고서|분석/);
    assert.equal((await app.query("SELECT status FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0].status, "active");
    if (document === "plan") {
      assert.equal((await getLatestPlanSubmission(app, plan, cycle)).reviewStatus, "approved");
      assert.equal((await app.query("SELECT form_data FROM investigation_plans WHERE id=$1", [plan])).rows[0].form_data.method, "재제출한 방법");
    } else assert.equal((await app.query("SELECT status FROM reports WHERE id=$1", [report])).rows[0].status, "reviewed");
    assert.deepEqual((await app.query("SELECT * FROM plan_document_snapshots WHERE plan_id=$1 ORDER BY id", [plan])).rows, planSnapshots);
    await requestCycleAnalysis(cycle, type, "teacher_bootstrap", generate);
    await move();
    const beforeStale = (await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows;
    const reportBeforeStale = (await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows;
    const history = (await app.query("SELECT * FROM document_revisions WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    await assert.rejects(review(), /회차|계획서|제출본/);
    assert.deepEqual((await app.query("SELECT * FROM investigation_plans WHERE id=$1", [plan])).rows, beforeStale);
    assert.deepEqual((await app.query("SELECT * FROM reports WHERE id=$1", [report])).rows, reportBeforeStale);
    assert.deepEqual((await app.query("SELECT * FROM document_revisions WHERE cycle_id=$1 ORDER BY id", [cycle])).rows, history);
    assert.equal((await app.query("SELECT id FROM notices WHERE source_id=$1 AND kind='action_request'", [document === "plan" ? plan : report])).rows.length, 0);
    results.push({ document, action, first, observedLockWait: true, approvalSaved: true, staleAnalysisRejected: true, reanalysisThenTransition: true, staleApprovalRejected: true, documentsAndHistoryPreserved: true });
    console.log(`${key}: passed`);
  }
  await writeFile(new URL(studentMode ? "postgres-positive-review-student-race.json" : "postgres-positive-review-race.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
