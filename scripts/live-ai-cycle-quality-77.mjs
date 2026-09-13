import {writeFile} from 'node:fs/promises';
import {createLocalTestDb} from './local-postgres-test-env.mjs';
process.loadEnvFile('.env.local'); const key=process.env.OPENAI_API_KEY;
if(!key)throw new Error('Existing approved key unavailable');
const {app,root}=await createLocalTestDb('live_cycle_quality');process.env.OPENAI_API_KEY=key;
const realFetch=fetch;globalThis.fetch=(x,y)=>{if(new URL(typeof x==='string'?x:x.url??String(x)).origin!=='https://api.openai.com')throw new Error('External destination denied');return realFetch(x,y);};
const {ensureInitialCycle}=await import('../src/lib/inquiry-cycles.ts');
const {requestCycleAnalysis,saveCycleDecision}=await import('../src/lib/cycle-analysis.ts');
const {transitionCycle}=await import('../src/lib/cycle-workflow.ts');
const results=[];
try{for(const mode of ['multiple-variables-one-cycle','optional-decisions-empty','chained-inquiry']){
  const id='cycle_eval_'+mode;
  await app.query("INSERT INTO teams(id,class_id,team_number,name,leader_user_id) VALUES($1,'class_2026_9',$2,'합성 평가 팀','demo_student_1')",[id,240+results.length]);
  await app.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,'demo_student_1')",[id]);
  await app.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'REPORTING')",[id]);
  let cycle=await ensureInitialCycle(app,id,'teacher_bootstrap');
  const multi=mode==='multiple-variables-one-cycle';
  const plan=multi?{topic:'물로켓 물의 양과 발사 각도 각각의 영향',purpose:'같은 회차 안에서 두 변인을 각각 비교한다.',method:'교사의 장치·안전구역 확인 및 감독 아래 시행한다. 물의 양을 비교할 때는 각도 45도로 고정하고, 각도를 비교할 때는 물 300mL로 고정한다. 나머지 조건은 같게 유지하고 각 조건을 3회 측정한다. 최적 조합은 검증하지 않았다.'}:{topic:'단열재 종류에 따른 보온 비교',purpose:'같은 두께의 단열재 A와 B를 비교한다.',method:'교사 확인 아래 같은 컵·물의 양·초기 온도 40℃·단열재 두께 10mm·주위 온도를 유지하고 10분 후 수온을 3회 측정한다.'};
  const report=multi?{data:'합성 자료: 45도 고정 시 물 300mL의 거리 20,21,20m, 400mL는 18,19,18m. 물 300mL 고정 시 30도는 17,18,17m, 45도는 20,21,20m. 400mL와 30도 조합은 측정하지 않음.',conclusion:'측정한 개별 조건의 차이만 비교하며 미측정 조합을 최적이라 하지 않는다.'}:{data:'합성 자료: 10분 후 A는 34,33,34℃, B는 30,31,30℃. 모든 시행의 초기 수온은 40℃.',conclusion:'이번 동일 두께 조건에서 A의 수온이 더 높게 유지됐다. 두께 효과는 아직 비교하지 않았다.'};
  await app.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'approved')",[id,cycle,JSON.stringify(plan)]);
  await app.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$1,$2,$3,'reviewed')",[id,cycle,JSON.stringify(report)]);
  let intermediate=null;
  if(!multi){
    intermediate=await requestCycleAnalysis(cycle,'intermediate','teacher_bootstrap');
    if(mode==='chained-inquiry'){
      await saveCycleDecision({analysisId:intermediate.id,suggestionId:intermediate.result.suggestions[0].id,decision:'modified',reason:'단열재 A만 사용하고 다음 회차에서 두께 10mm와 20mm의 차이를 비교하기로 한다.',expectedVersion:null,studentId:'demo_student_1'});
      cycle=(await transitionCycle({cycleId:cycle,action:'start_next',teacherId:'teacher_bootstrap'})).nextCycleId;
      await app.query("UPDATE investigation_plans SET form_data=$2,review_status='approved' WHERE id=$1",[id,JSON.stringify({topic:'단열재 A의 두께 비교',purpose:'이전 회차 판단에 따라 두께만 바꿔 보온 효과를 확인한다.',method:'이전 회차와 같은 물의 양·초기 수온 40℃·컵·주위 온도에서 A의 두께만 10mm와 20mm로 바꾸고 10분 후 수온을 3회 비교한다.'})]);
      await app.query("UPDATE reports SET form_data=$2,status='reviewed' WHERE id=$1",[id,JSON.stringify({data:'합성 자료: 10mm는 34,33,34℃, 20mm는 36,35,36℃.',conclusion:'이번 조건에서 20mm가 더 높은 수온을 유지했다. 다른 재료·두께는 검증하지 않았다.'})]);
    }
  }
  const response=await requestCycleAnalysis(cycle,'final','teacher_bootstrap');
  results.push({id:mode,intermediate:intermediate?.result??null,response});
  await writeFile(new URL('live-ai-cycle-quality-77.json',root),JSON.stringify({syntheticOnly:true,results},null,2));
  console.log(JSON.stringify({case:mode,status:'completed'}));
}}finally{process.env.OPENAI_API_KEY='';await app.end();}
