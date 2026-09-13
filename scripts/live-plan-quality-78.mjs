import {readFile,writeFile} from 'node:fs/promises';
import {createLocalTestDb} from './local-postgres-test-env.mjs';
process.loadEnvFile('.env.local');const key=process.env.OPENAI_API_KEY;
if(!key)throw new Error('Approved existing key unavailable');
const {app}=await createLocalTestDb('plan_quality_final');process.env.OPENAI_API_KEY=key;
const originalFetch=fetch;globalThis.fetch=(x,y)=>{if(new URL(typeof x==='string'?x:x.url??String(x)).origin!=='https://api.openai.com')throw new Error('Unexpected destination');return originalFetch(x,y);};
const {ensureInitialCycle}=await import('../src/lib/inquiry-cycles.ts');
const {createPlanSubmission}=await import('../src/lib/plan-snapshots.ts');
const {requestStudentPlanAiReview,requestTeacherPlanAiReview}=await import('../src/lib/plan-ai-review.ts');
const cases=JSON.parse(await readFile('AI_QUALITY_CASES.json','utf8')).cases.filter(x=>x.feature.startsWith('plan_review'));
const results=[];
try{for(const sample of [...cases,...Array(2).fill(cases.find(x=>x.id==='teacher-decision-boundary'))]){
 const id=`quality_78_${results.length}`,teacher=sample.feature==='plan_review_teacher';
 await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 품질 팀','demo_student_1')",[id,280+results.length]);
 await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,'demo_student_1')",[id]);
 await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'PLANNING')",[id]);
 const cycle=await ensureInitialCycle(app,id,'teacher_bootstrap');
 const form={field:'과학',topic:'온도와 용해 속도 비교',motivation:'생활 속 차이 관찰',purpose:'온도에 따른 용해 시간 비교',method:sample.input,expectedResult:'차이가 있을 것으로 예상한다.'};
 await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,$4)",[id,cycle,JSON.stringify(form),teacher?'pending':'draft']);
 if(teacher)await createPlanSubmission(app,id,'demo_student_1');
 const response=teacher?await requestTeacherPlanAiReview(id,'teacher_bootstrap'):await requestStudentPlanAiReview(id,'demo_student_1');
 results.push({id:sample.id,run:results.filter(x=>x.id===sample.id).length+1,input:form,response});
 await writeFile('output/test-infra/live-plan-quality-78.json',JSON.stringify({syntheticOnly:true,results},null,2));
 console.log(JSON.stringify({id:sample.id,run:results.at(-1).run,completed:true}));
}}finally{process.env.OPENAI_API_KEY='';await app.end();}
