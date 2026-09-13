// Native app services with a loader-enforced, network-free provider double.
// node --experimental-transform-types --import ./scripts/local-ai-test-loader.mjs scripts/local-postgres-ai-cycle-race.mjs [--reproduce]
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app, root, database, postgresVersion } = await createLocalTestDb("ai_cycle");
process.env.OPENAI_API_KEY = "synthetic-not-a-real-key";
process.env.OPENAI_BASE_URL = "http://127.0.0.1:1";
globalThis.fetch = async () => { throw new Error("Network is forbidden in this synthetic test"); };
const { generateTopicSuggestions, sendTeamMessage } = await import("../src/lib/ai.ts");
const { ensureInitialCycle } = await import("../src/lib/inquiry-cycles.ts");
const { requestCycleAnalysis } = await import("../src/lib/cycle-analysis.ts");
const { transitionCycle } = await import("../src/lib/cycle-workflow.ts");
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const reproduce = process.argv.includes("--reproduce"), results = [];
const analysis = async () => ({ model: "synthetic", result: { overview: "합성 검증", inquiryField: "화학", researchType: "비교", strengths: [], findings: [], suggestions: [{ title: "측정 확인", rationale: "계획 확인", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격 확인", safetyNote: "보호 장비", questionForStudents: "측정 간격은?" }], cycleComparison: [], limitations: [] } });
try {
  for (const kind of ["chat", "topic"]) for (const action of ["start_next", "finish_project"]) {
    const key = `${kind}_${action}`, team = `team_${key}`, session = `session_${key}`;
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 AI팀','demo_student_1')", [team, 100 + results.length]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,'demo_student_1')", [`member_${key}`, team]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,selected_topic,stage) VALUES($1,$2,'합성 측정','REPORTING')", [session, team]);
    const cycle = await ensureInitialCycle(app, session, "teacher_bootstrap");
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [`plan_${key}`, session, cycle, { topic: "합성 측정" }]);
    await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [`report_${key}`, session, cycle, { analysis: "합성 측정 결과" }]);
    let reached, resume, calls = 0;
    const ready = new Promise(resolve => { reached = resolve; }), release = new Promise(resolve => { resume = resolve; });
    globalThis.__syntheticOpenAI = async (requestedKind, input) => {
      assert.equal(requestedKind, kind); assert.ok(input.input); calls++; reached(); await release;
      return kind === "chat" ? { output_text: "합성 늦은 AI 답변", output: [] } : { output: [], output_parsed: { directions: Array.from({ length: 3 }, (_, index) => ({ title: `합성 방향 ${index}`, reason: "합성", relation: "합성", candidateQuestion: "합성 질문", variables: ["온도"], feasibility: "합성", safetyNote: "합성" })) } };
    };
    const working = settle(kind === "chat" ? sendTeamMessage(session, team, { id: "demo_student_1", alias: "팀원 A" }, "합성 질문", key, cycle) : generateTopicSuggestions(session, team, "합성 관심사", "demo_student_1", key, cycle));
    const timer = setTimeout(resume, 15000);
    try {
      await Promise.race([ready, working.then(result => { throw result.error ?? new Error("Generation ended before pause"); })]);
      // Analyze the already-preserved student question before the transition.
      await requestCycleAnalysis(cycle, action === "start_next" ? "intermediate" : "final", "teacher_bootstrap", analysis);
      await transitionCycle({ cycleId: cycle, action, teacherId: "teacher_bootstrap" });
    } finally { clearTimeout(timer); resume(); }
    const result = await working; assert.equal(calls, 1); assert.equal(result.ok, reproduce, result.error?.message);
    if (!reproduce) assert.match(result.error.message, /회차/);
    const state = (await app.query("SELECT stage,interest_input FROM inquiry_sessions WHERE id=$1", [session])).rows[0];
    const messages = (await app.query("SELECT role,cycle_id,content FROM messages WHERE session_id=$1 ORDER BY sequence", [session])).rows;
    if (kind === "chat") {
      assert.equal(messages.filter(row => row.role === "user").length, 1);
      assert.equal(messages.filter(row => row.role === "assistant").length, reproduce ? 1 : 0);
      assert.ok(messages.every(row => row.cycle_id === cycle));
    } else assert.equal(state.interest_input, reproduce ? "합성 관심사" : null);
    if (!reproduce) assert.equal(state.stage, action === "start_next" ? "STARTING" : "COMPLETED");
    results.push({ kind, action, reproduced: reproduce, acceptedLateResponse: result.ok, stage: state.stage, studentQuestionPreserved: kind === "chat" });
    console.log(`${key}: ${reproduce ? "late write reproduced" : "passed"}`);
  }
  await writeFile(new URL(reproduce ? "postgres-ai-cycle-before.json" : "postgres-ai-cycle-after.json", root), JSON.stringify({ database, postgresVersion, results }, null, 2));
} finally { await app.end(); }
