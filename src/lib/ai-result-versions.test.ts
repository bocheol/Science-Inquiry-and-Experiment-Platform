import {expect,it,vi} from "vitest";
import {getDb} from "@/lib/db";
import {ensureInitialCycle} from "@/lib/inquiry-cycles";
import {getPlanAiReview,getLatestPlanAiReviewForPlan,requestStudentPlanAiReview} from "@/lib/plan-ai-review";
import {getCycleJourney,requestCycleAnalysis,saveCycleDecision} from "@/lib/cycle-analysis";
import {transitionCycle} from "@/lib/cycle-workflow";

let number=170;
async function fixture() {
  const db=await getDb(),id=`version_fixture_${++number}`;
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ($1,'class_2026_9',$2,'합성 버전 팀')",[id,number]);
  await db.query("INSERT INTO team_members (id,team_id,user_id) VALUES ($1,$1,'demo_student_1')",[id]);
  await db.query("INSERT INTO inquiry_sessions (id,team_id,stage) VALUES ($1,$1,'REPORTING')",[id]);
  const cycleId=await ensureInitialCycle(db,id,"teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans (id,session_id,cycle_id,form_data,review_status) VALUES ($1,$1,$2,$3,'approved')",[id,cycleId,JSON.stringify({topic:"합성 측정 탐구"})]);
  await db.query("INSERT INTO reports (id,session_id,cycle_id,status) VALUES ($1,$1,$2,'reviewed')",[id,cycleId]);
  return {db,id,cycleId};
}

it.each(["prompt_version","schema_version"] as const)("keeps legacy plan %s results but generates and reuses the current version",async column=>{
  const {db,id,cycleId}=await fixture();
  const generate=vi.fn(async()=>({model:"synthetic",result:{readiness:"needs_revision" as const,summary:"합성 점검",strengths:[],checks:[],limitations:[]}}));
  const first=await requestStudentPlanAiReview(id,"demo_student_1",generate);
  await db.query(`UPDATE plan_ai_reviews SET ${column} = 'legacy-v0' WHERE id = $1`,[first.id]);
  await db.query("UPDATE ai_generation_jobs SET request_key = $1 WHERE id = (SELECT ai_job_id FROM plan_ai_reviews WHERE id = $2)",["legacy-"+first.id,first.id]);
  expect(await getPlanAiReview(first.snapshotId,"student")).toBeNull();
  expect(await getLatestPlanAiReviewForPlan(id,"student",cycleId)).toBeNull();
  const current=await requestStudentPlanAiReview(id,"demo_student_1",generate);
  expect(current.id).not.toBe(first.id);
  expect(current.snapshotId).toBe(first.snapshotId);
  expect((await requestStudentPlanAiReview(id,"demo_student_1",generate)).id).toBe(current.id);
  expect(generate).toHaveBeenCalledTimes(2);
  expect((await db.query("SELECT id FROM plan_ai_reviews WHERE snapshot_id = $1",[first.snapshotId])).rows).toHaveLength(2);
  expect((await db.query("SELECT result_json FROM plan_ai_reviews WHERE id = $1",[first.id])).rows[0].result_json).toEqual(first.result);
  expect((await getLatestPlanAiReviewForPlan(id,"student",cycleId))!.id).toBe(current.id);
});

it.each(["prompt_version","schema_version"] as const)("marks legacy cycle %s results stale and preserves them when regenerated",async column=>{
  const {db,id,cycleId}=await fixture();
  const generate=vi.fn(async()=>({model:"synthetic",result:{overview:"합성 분석",inquiryField:"과학",researchType:"측정",strengths:[],findings:[],cycleComparison:[],limitations:[],suggestions:[{title:"측정 확인",rationale:"비교",evidenceIds:["plan:topic"],feasibleNextStep:"기록 검토",safetyNote:"",questionForStudents:"기준이 같은가요?"}]}}));
  const first=await requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",generate);
  await db.query(`UPDATE cycle_ai_analyses SET ${column} = 'legacy-v0' WHERE id = $1`,[first.id]);
  await db.query("UPDATE ai_generation_jobs SET request_key = $1 WHERE id = (SELECT ai_job_id FROM cycle_ai_analyses WHERE id = $2)",["legacy-"+first.id,first.id]);
  expect((await getCycleJourney(id))[0]!.analysis!.isCurrent).toBe(false);
  await expect(saveCycleDecision({analysisId:first.id,suggestionId:first.result.suggestions[0]!.id,decision:"accepted",reason:"예전 분석에서 저장 시도",expectedVersion:null,studentId:"demo_student_1"})).rejects.toThrow("최신 분석");
  await expect(transitionCycle({cycleId,teacherId:"teacher_bootstrap",action:"start_next"})).rejects.toThrow("다시 분석");
  const current=await requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",generate);
  expect(current.id).not.toBe(first.id);
  expect(current.snapshotId).toBe(first.snapshotId);
  expect(current.isCurrent).toBe(true);
  expect((await requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",generate)).id).toBe(current.id);
  expect(generate).toHaveBeenCalledTimes(2);
  expect((await getCycleJourney(id))[0]!.analysisHistory.some(item=>item.id===first.id)).toBe(true);
  expect((await db.query("SELECT id FROM cycle_ai_analyses WHERE snapshot_id = $1",[first.snapshotId])).rows).toHaveLength(2);
  expect((await db.query("SELECT result_json FROM cycle_ai_analyses WHERE id = $1",[first.id])).rows[0].result_json).toEqual(first.result);
});
