// Real transactions and services; the import loader guarantees synthetic sheet transport.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("material_completion");
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const { retryMaterialSync } = await import("../src/lib/materials.ts");
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");
const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const reproduce = process.argv.includes("--reproduce"), results = [];
const analyze = async () => ({ model: "synthetic", result: { overview: "합성 전송 검증", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "기록 비교", rationale: "자료 확인", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격 비교", safetyNote: "", questionForStudents: "조건은?" }] } });
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
let gate;
const connect = app.connect.bind(app);
app.connect = (...args) => {
  if (args.length) return connect(...args);
  return (async () => {
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
};
async function waitBlocked(blocker) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const rows = (await app.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [blocker])).rows;
    if (rows.length) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("No database lock wait observed");
}
try {
  for (const action of ["start_next", "finish_project"]) for (const first of reproduce ? ["transition"] : ["transition", "completion"]) {
    const key = `${action}_${first}`, team = `team_${key}`, session = `session_${key}`, request = `request_${key}`, operation = `operation_${key}`, sheet = `synthetic_sheet_${key}`;
    await app.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',$2,'합성 완료 경합 팀')", [team, 800 + results.length]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$2,'REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')", [session, cycle, { topic: "합성 측정" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,status) VALUES($1,$1,$2,'reviewed')", [session, cycle]);
    const items = [{ name: "합성 비커", specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "" }];
    const batch = { requests: [], receiptId: operation, sheetName: "synthetic", rowCount: 1 };
    await app.query("INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,sync_snapshot,sync_operation_id,sync_batch) VALUES($1,$1,$2,$3,$4,'demo_student_1',$5,$6,$7,$8)", [request, session, cycle, team, JSON.stringify(items), JSON.stringify({ spreadsheetId: sheet, items }), operation, JSON.stringify(batch)]);
    await app.query("INSERT INTO material_sheet_dispatch(spreadsheet_id,operation_id,request_id) VALUES($1,$2,$3)", [sheet, operation, request]);
    const kind = action === "start_next" ? "intermediate" : "final";
    await requestCycleAnalysis(cycle, kind, "teacher_bootstrap", analyze);
    let reached, resume, calls = 0;
    const ready = new Promise(resolve => { reached = resolve; }), pause = new Promise(resolve => { resume = resolve; });
    gate = { used: false, reached, pause, pid: null, match: sql => first === "transition" ? sql.includes("SELECT m.id FROM material_requests") && sql.includes("LIMIT 1") : sql.includes("UPDATE material_requests SET sync_status = 'synced'") };
    globalThis.__syntheticSheetTransfer = async (target, received) => { assert.equal(target, sheet); assert.deepEqual(received, batch); calls++; return { rowCount: 1 }; };
    const move = () => transitionCycle({ cycleId: cycle, action, teacherId: "teacher_bootstrap" });
    const send = () => retryMaterialSync(request, "teacher_bootstrap");
    const one = settle(first === "transition" ? move() : send());
    let two, waitingPid;
    const timer = setTimeout(resume, 15000);
    try {
      await Promise.race([ready, one.then(result => { throw result.error ?? new Error("First operation ended before pause"); })]);
      two = settle(first === "transition" ? send() : move());
      if (reproduce) assert.equal((await two).ok, true);
      else waitingPid = await Promise.race([waitBlocked(gate.pid), two.then(result => { throw result.error ?? new Error("Second operation did not wait"); })]);
    } finally { clearTimeout(timer); resume(); }
    const [a, b] = await Promise.all([one, two]); gate = null;
    const transition = first === "transition" ? a : b, sent = first === "transition" ? b : a;
    assert.equal(sent.ok, true, sent.error?.message); assert.equal(sent.value.syncStatus, "synced"); assert.equal(calls, 1);
    assert.equal(transition.ok, reproduce, transition.error?.message);
    if (!reproduce) {
      assert.match(transition.error.message, /자료|준비물/);
      assert.equal((await app.query("SELECT status FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0].status, "active");
      await requestCycleAnalysis(cycle, kind, "teacher_bootstrap", analyze);
      await move();
    }
    assert.equal((await app.query("SELECT sync_status FROM material_requests WHERE id=$1", [request])).rows[0].sync_status, "synced");
    assert.equal((await app.query("SELECT * FROM material_sheet_dispatch WHERE spreadsheet_id=$1", [sheet])).rows.length, 0);
    results.push({ action, first, reproduced: reproduce, staleAnalysisTransitionAllowed: transition.ok, observedLockWait: Boolean(waitingPid), reanalysisThenTransitionAllowed: !reproduce });
    console.log(`${key}: ${reproduce ? "stale transition reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-material-completion-before.json" : "postgres-material-completion-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
