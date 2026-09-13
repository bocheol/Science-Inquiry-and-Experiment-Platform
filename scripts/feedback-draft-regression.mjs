// Local synthetic accounts only; feedback requests are intercepted before storage.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base='http://127.0.0.1:3107';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const student=await browser.newContext(), teacher=await browser.newContext({viewport:{width:768,height:1024}});
 const check=async response=>assert.equal(response.status(),200,await response.text());
 await check(await student.request.post(base+'/api/auth/login',{data:{loginId:'10901',password:'student1234'}}));
 await check(await teacher.request.post(base+'/api/auth/login',{data:{loginId:'teacher',password:'local-editor-regression-only'}}));
 const read=async()=>(await (await student.request.get(base+'/api/inquiry?team=demo_team_1')).json()).data;
 let data=await read();const cycleId=data.session.cycle.id;
 if(data.plan.reviewStatus!=='approved') {
  for(const field of data.plan.fields.filter(f=>f.required)) await check(await student.request.patch(base+'/api/inquiry/plan',{data:{cycleId,planId:data.plan.id,fieldKey:field.id,value:field.id==='field'?'화학':'합성 검증 자료'}}));
  await check(await student.request.post(base+'/api/inquiry/plan',{data:{cycleId,planId:data.plan.id,action:'submit'}}));
  data=await read();
  await check(await teacher.request.post(base+'/api/teacher/plans/review',{data:{action:'review',planId:data.plan.id,decision:'approved',feedback:'',expected:{cycleId,submissionId:data.plan.latestSubmission.id,status:data.plan.reviewStatus,feedback:data.plan.teacherFeedback??''}}}));
 }
 for(const field of data.report.fields.filter(f=>f.required)) await check(await student.request.patch(base+'/api/inquiry/report',{data:{kind:'field',cycleId,reportId:data.report.id,fieldKey:field.id,value:'합성 보고서 자료'}}));
 for(const role of data.report.roles.filter(r=>r.isActive)) await check(await student.request.patch(base+'/api/inquiry/report',{data:{kind:'role',cycleId,reportId:data.report.id,userId:role.userId,value:'합성 역할'}}));
 await check(await student.request.post(base+'/api/inquiry/report',{data:{action:'submit',cycleId,reportId:data.report.id}}));
 const page=await teacher.newPage();page.setDefaultTimeout(30000);
 await page.route('**/api/notices',r=>r.fulfill({json:{feed:{notices:[],unreadCount:0,unreadImportantCount:0,popupNotice:null}}}));
 let fail=true, release, requests=0, real=false;
 await page.route('**/api/teacher/reports/review',async route=>{
  requests++;
  if(real) return route.continue();
  if(fail) return route.abort('failed');
  await new Promise(resolve=>{release=resolve;});
  await route.fulfill({json:{ok:true}});
 });
 await page.goto(base+'/teacher/team/demo_team_1');
 const feedback=page.locator('#report-feedback');
 await feedback.fill('아직 보내지 않은 보고서 피드백');
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#report-feedback')?.value==='아직 보내지 않은 보고서 피드백');
 assert.equal(requests,0);
 const section=page.locator('section').filter({has:feedback});
 await section.getByRole('button',{name:'수정 요청',exact:true}).click();
 await section.getByText('연결이 끊겼거나 응답이 늦습니다.',{exact:false}).waitFor();
 assert.equal(await feedback.inputValue(),'아직 보내지 않은 보고서 피드백');
 fail=false;
 await section.getByRole('button',{name:'수정 요청',exact:true}).click();
 while(!release) await page.waitForTimeout(50);
 await feedback.fill('응답 대기 중 추가로 쓴 피드백');
 release();
 await section.getByText('학생 팀에 수정 요청을 보냈습니다.',{exact:true}).waitFor();
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#report-feedback')?.value==='응답 대기 중 추가로 쓴 피드백');
 assert.equal(requests,2);
 const current=await read();
 await check(await teacher.request.post(base+'/api/teacher/reports/review',{data:{action:'review',reportId:current.report.id,decision:'feedback',feedback:'다른 교사가 먼저 저장한 피드백',expected:{cycleId,version:current.report.reviewVersion,status:current.report.status,feedback:current.report.teacherFeedback??''}}}));
 await page.reload();
 await section.getByRole('button',{name:'최신 보고서를 확인하고 초안 유지',exact:true}).waitFor();
 assert.equal(await section.getByRole('button',{name:'수정 요청',exact:true}).isDisabled(),true);
 assert.equal(await feedback.inputValue(),'응답 대기 중 추가로 쓴 피드백');
 await section.getByRole('button',{name:'최신 보고서를 확인하고 초안 유지',exact:true}).click();
 real=true;
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/teacher/reports/review'));
 await section.getByRole('button',{name:'수정 요청',exact:true}).click();
 assert.equal((await saved).status(),200);
 assert.equal((await read()).report.teacherFeedback,'응답 대기 중 추가로 쓴 피드백');
 await page.evaluate(()=>{
  const key=Object.keys(sessionStorage).find(key=>key.startsWith('science:report-feedback:'));
  // A successful save may clear storage, so recover the identity from the current fixture.
  const draftKey=key || 'science:report-feedback:'+JSON.stringify(['teacher_bootstrap','demo_team_1','report_demo_session_1','cycle_demo_session_1_1',null]);
  sessionStorage.setItem(draftKey,JSON.stringify({token:crypto.randomUUID(),value:'이전 형식에 남겨 둔 보고서 피드백'}));
 });
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#report-feedback')?.value==='이전 형식에 남겨 둔 보고서 피드백');
 assert.equal(await section.getByRole('button',{name:'수정 요청',exact:true}).isDisabled(),true);
 await feedback.fill('예전 초안에 이어 쓴 문장');
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#report-feedback')?.value==='예전 초안에 이어 쓴 문장');
 assert.equal(await section.getByRole('button',{name:'수정 요청',exact:true}).isDisabled(),true);
 assert.equal(requests,3);
 console.log('PASS: legacy unbound feedback stays readable and editable across reload without silently adopting a new report target');
 console.log('PASS: another teacher change blocks a recovered draft until explicit review, then feedback resend stores the preserved text');
 console.log('PASS: report feedback reload recovery, no automatic send, network failure retry and late response preserves newer draft');
} finally {await browser.close();}
