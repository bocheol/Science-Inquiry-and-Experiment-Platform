// Existing approved key stays in memory; only synthetic fixtures are sent.
import { readFile, writeFile } from "node:fs/promises";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
process.loadEnvFile('.env.local');
const key=process.env.OPENAI_API_KEY;
if(!key)throw new Error('Approved existing key is unavailable');
const {app,root}=await createLocalTestDb('live_ai_quality');
process.env.OPENAI_API_KEY=key;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url??String(input));
  if(url.origin!=='https://api.openai.com')throw new Error('Unexpected external destination');
  return originalFetch(input,init);
};
const {ensureInitialCycle}=await import('../src/lib/inquiry-cycles.ts');
const {createPlanSubmission}=await import('../src/lib/plan-snapshots.ts');
const {requestStudentPlanAiReview,requestTeacherPlanAiReview}=await import('../src/lib/plan-ai-review.ts');
const {requestCycleAnalysis}=await import('../src/lib/cycle-analysis.ts');
const {sendTeamMessage}=await import('../src/lib/ai.ts');
const cases=JSON.parse(await readFile(new URL('../AI_QUALITY_CASES.json',import.meta.url),'utf8')).cases;
const results=[];
try{
  for(const sample of cases.filter(c=>c.id!=='chained-inquiry')){
    const id=`quality_${sample.id}`, teacher=sample.feature==='plan_review_teacher', analysis=sample.feature==='cycle_analysis_final';
    await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 품질 팀','demo_student_1')",[id,200+results.length]);
    await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,'demo_student_1')",[id]);
    await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'REPORTING')",[id]);
    const cycle=await ensureInitialCycle(app,id,'teacher_bootstrap');
    const form={field:'과학',topic:'온도와 용해 속도 비교',motivation:'생활 속 차이 관찰',purpose:'온도에 따른 용해 시간 비교',method:sample.input,expectedResult:'차이가 있을 것으로 예상한다.'};
    await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,$4)",[id,cycle,JSON.stringify(form),analysis?'approved':teacher?'pending':'draft']);
    if(teacher)await createPlanSubmission(app,id,'demo_student_1');
    if(analysis)await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$1,$2,$3,'reviewed')",[id,cycle,JSON.stringify({results:sample.input+' 합성 측정 기록: 조건 A의 3회 측정은 10, 11, 12초, 조건 B는 20, 21, 22초. 다른 조건의 조합은 측정하지 않았다.',conclusion:'조건별 차이를 비교했다. 다른 조건은 검증하지 않았다.'})]);
    try{
      const response=analysis?await requestCycleAnalysis(cycle,'final','teacher_bootstrap')
        :sample.feature==='team_chat'?await sendTeamMessage(id,id,{id:'demo_student_1',alias:'합성 작성자'},sample.input,'quality-77',cycle)
        :teacher?await requestTeacherPlanAiReview(id,'teacher_bootstrap'):await requestStudentPlanAiReview(id,'demo_student_1');
      results.push({id:sample.id,feature:sample.feature,input:form,response,status:'completed'});
    }catch(error){results.push({id:sample.id,feature:sample.feature,status:'failed',errorType:error?.name??'Error',statusCode:error?.status??null});}
    await writeFile(new URL('live-ai-quality-77.json',root),JSON.stringify({syntheticOnly:true,skipped:['chained-inquiry'],results},null,2));
    console.log(JSON.stringify({case:sample.id,status:results.at(-1).status}));
  }
}finally{process.env.OPENAI_API_KEY='';await app.end();}
