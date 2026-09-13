import { expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { getCycleJourney, requestCycleAnalysis, saveCycleDecision } from "@/lib/cycle-analysis";
import { transitionCycle } from "@/lib/cycle-workflow";

const result = {
  overview: "합성 탐구 분석", inquiryField: "물리", researchType: "여러 변인 비교",
  strengths: [], findings: [], cycleComparison: [], limitations: [],
  suggestions: [{title:"측정 기준 확인",rationale:"같은 기준 비교",evidenceIds:["plan:topic"],feasibleNextStep:"측정 기록 확인",safetyNote:"",questionForStudents:"측정 기준이 같은가요?"}],
};

it.each(["member", "teacher", "inactive", "password"])("decision writes check the current %s account while preserving the analysis", async state => {
  const db = await getDb(), id = `decision_account_${state}`, actor = `${id}_actor`;
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 판단 계정',$1,2026,'student','class_2026_9','unused',FALSE)", [actor]);
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,'class_2026_9',$2,'합성 판단팀')", [id, 220 + ["member", "teacher", "inactive", "password"].indexOf(state)]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [id, actor]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'REPORTING')", [id]);
  const cycle = await ensureInitialCycle(db, id, "teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')", [id, cycle, JSON.stringify({ topic: "합성 주제" })]);
  await db.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$1,$2,$3,'reviewed')", [id, cycle, JSON.stringify({ title: "합성 결과" })]);
  const analysis = await requestCycleAnalysis(cycle, "intermediate", "teacher_bootstrap", async () => ({ result, model: "synthetic" }));
  const source = (await db.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1", [cycle])).rows;
  const original = (await db.query("SELECT * FROM cycle_ai_analyses WHERE id=$1", [analysis.id])).rows;
  if (state === "teacher") await db.query("UPDATE users SET role='teacher' WHERE id=$1", [actor]);
  if (state === "inactive") await db.query("UPDATE users SET status='inactive' WHERE id=$1", [actor]);
  if (state === "password") await db.query("UPDATE users SET must_change_password=TRUE WHERE id=$1", [actor]);
  const call = saveCycleDecision({ analysisId: analysis.id, suggestionId: analysis.result.suggestions[0]!.id, decision: "accepted", reason: "합성 판단", expectedVersion: null, studentId: actor });
  if (state === "member") await expect(call).resolves.toMatchObject({ version: 1 });
  else await expect(call).rejects.toThrow("권한");
  expect((await db.query("SELECT id FROM cycle_ai_decisions WHERE analysis_id=$1", [analysis.id])).rows).toHaveLength(state === "member" ? 1 : 0);
  expect((await db.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1", [cycle])).rows).toEqual(source);
  expect((await db.query("SELECT * FROM cycle_ai_analyses WHERE id=$1", [analysis.id])).rows).toEqual(original);
});

it.each([false, true])("finishes one cycle after intermediate analysis, with decisions=%s, preserving history", async withDecision => {
  const db = await getDb(), id = `single_cycle_${withDecision}`;
  await db.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ($1, 'class_2026_9', $2, '단일 탐구 합성팀')", [id, withDecision ? 198 : 197]);
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $1, 'demo_student_1')", [id]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $1, 'REPORTING')", [id]);
  const cycleId = await ensureInitialCycle(db, id, "teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id, form_data, review_status) VALUES ($1, $1, $2, $3, 'approved')", [id, cycleId, JSON.stringify({topic:"물로켓 변인별 비교"})]);
  await db.query("INSERT INTO reports (id, session_id, cycle_id, form_data, status) VALUES ($1, $1, $2, $3, 'reviewed')", [id, cycleId, JSON.stringify({title:"변인별 비교 결과"})]);
  const intermediate = await requestCycleAnalysis(cycleId, "intermediate", "teacher_bootstrap", async () => ({result,model:"synthetic"}));
  const decision = {analysisId:intermediate.id,suggestionId:intermediate.result.suggestions[0]!.id,decision:"modified" as const,reason:"같은 회차에서 측정 기준을 확인한다.",expectedVersion:null,studentId:"demo_student_1"};
  if (withDecision) await saveCycleDecision(decision);
  expect((await getCycleJourney(id))[0]!.analysis!.isCurrent).toBe(true);
  const generate = vi.fn(async ({snapshot}: {snapshot: {trajectoryContext: Array<{cycleId:string;decisions: unknown[]}>}}) => {
    expect(snapshot.trajectoryContext).toHaveLength(1);
    expect(snapshot.trajectoryContext[0]).toMatchObject({cycleId});
    expect(snapshot.trajectoryContext[0]!.decisions).toHaveLength(withDecision ? 1 : 0);
    return {result,model:"synthetic"};
  });
  const final = await requestCycleAnalysis(cycleId, "final", "teacher_bootstrap", generate);
  expect(final.analysisType).toBe("final");
  expect(final.isCurrent).toBe(true);
  expect((await requestCycleAnalysis(cycleId, "final", "teacher_bootstrap", generate)).id).toBe(final.id);
  expect(generate).toHaveBeenCalledTimes(1);
  const journey = await getCycleJourney(id);
  expect(journey).toHaveLength(1);
  expect(journey[0]!.analysisHistory).toHaveLength(1);
  expect(journey[0]!.analysisHistory[0]).toMatchObject({id:intermediate.id,analysisType:"intermediate"});
  expect(journey[0]!.analysisHistory[0]!.decisions).toHaveLength(withDecision ? 1 : 0);
  await expect(saveCycleDecision({...decision,reason:"최종 분석 뒤의 수정"})).rejects.toThrow("최종 분석");
  await expect(requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",async()=>({result,model:"synthetic"}))).rejects.toThrow("최종 분석");
  await expect(transitionCycle({cycleId,action:"start_next",teacherId:"teacher_bootstrap"})).rejects.toThrow("최종 분석");
  await transitionCycle({cycleId,action:"finish_project",teacherId:"teacher_bootstrap"});
  expect((await db.query("SELECT stage FROM inquiry_sessions WHERE id = $1",[id])).rows[0].stage).toBe("COMPLETED");
  expect((await getCycleJourney(id))[0]!.analysisHistory[0]!.id).toBe(intermediate.id);
});
