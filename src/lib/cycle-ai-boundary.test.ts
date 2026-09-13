import { expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { requestCycleAnalysis } from "@/lib/cycle-analysis";

it("redacts cycle titles and rejects empty or omitted evidence before storing analysis", async () => {
  const db=await getDb(), id="cycle_boundary_fixture";
  await db.query("INSERT INTO users (id, name, login_id, academic_year, role, password_hash) VALUES ('boundary_private_student','합성가림대상','boundary-private-login',2026,'student','unused')");
  await db.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ($1, 'class_2026_9', 196, '합성 경계 팀')",[id]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $1, 'REPORTING')",[id]);
  const cycleId=await ensureInitialCycle(db,id,"teacher_bootstrap");
  await db.query("UPDATE inquiry_cycles SET title = '합성가림대상 19888 private@example.com 010-1234-5678' WHERE id = $1",[cycleId]);
  const form=Object.fromEntries(Array.from({length:25},(_,index)=>[`field_${index}`,"측정".repeat(6000)]));
  await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id, form_data, review_status) VALUES ($1,$1,$2,$3,'approved')",[id,cycleId,JSON.stringify(form)]);
  await db.query("INSERT INTO reports (id, session_id, cycle_id, status) VALUES ($1,$1,$2,'reviewed')",[id,cycleId]);
  let mode:"empty"|"omitted"|"valid"="empty";
  const generate=vi.fn(async ({prepared}:{prepared:{text:string;sourceIds:string[]}})=>{
    expect(prepared.text).not.toContain("19888");
    expect(prepared.text).not.toContain("합성가림대상");
    expect(prepared.text).not.toContain("private@example.com");
    expect(prepared.text).not.toContain("010-1234-5678");
    expect(prepared.sourceIds.length).toBeLessThan(Object.keys(form).length);
    const omitted=Object.keys(form).map(key=>`plan:${key}`).find(key=>!prepared.sourceIds.includes(key))!;
    expect(omitted).toBeTruthy();
    const evidenceIds=mode==="empty"?[]:mode==="omitted"?[omitted]:[prepared.sourceIds[0]!];
    return {model:"synthetic",result:{overview:"합성 검토",inquiryField:"과학",researchType:"측정",strengths:[],findings:[],cycleComparison:[],limitations:[],suggestions:[{title:"측정 검토",rationale:"자료 확인",evidenceIds,feasibleNextStep:"기록 비교",safetyNote:"",questionForStudents:"기준이 같은가요?"}]}};
  });
  await expect(requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",generate)).rejects.toThrow("근거가 없습니다");
  expect((await db.query("SELECT id FROM cycle_ai_analyses WHERE cycle_id = $1",[cycleId])).rows).toHaveLength(0);
  mode="omitted";
  await expect(requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",generate)).rejects.toThrow("제공되지 않은 근거");
  expect((await db.query("SELECT id FROM cycle_ai_analyses WHERE cycle_id = $1",[cycleId])).rows).toHaveLength(0);
  mode="valid";
  await requestCycleAnalysis(cycleId,"intermediate","teacher_bootstrap",generate);
  expect((await db.query("SELECT id FROM cycle_ai_analyses WHERE cycle_id = $1",[cycleId])).rows).toHaveLength(1);
});
