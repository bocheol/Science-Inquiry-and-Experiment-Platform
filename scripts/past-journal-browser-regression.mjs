// Synthetic local UI responses; no actual journal or teacher setting is changed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:3107';
const past={id:'synthetic-past-cycle',ordinal:0,title:'완료된 합성 탐구',status:'completed',origin:'configured',startedAt:null,endedAt:null,analysis:null,analysisHistory:[]};
const journal={id:'synthetic-journal',sessionId:'demo_session_1',cycleId:past.id,studentId:'demo_student_1',sessionNumber:1,date:'2026-09-01',activities:'이전 회차의 실험 기록',observations:'이전 회차의 관찰',reflections:'보존된 개인 성찰',version:1,images:[{id:'synthetic-photo',clientId:'synthetic-photo',url:'/api/journal-images/synthetic-photo'}],createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'};
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const audience of ['student','teacher']) {
  const context=await browser.newContext({viewport:{width:768,height:1024}});
  const login=audience==='student'?{loginId:'10901',password:'student1234'}:{loginId:'teacher',password:'local-editor-regression-only'};
  assert.equal((await context.request.post(base+'/api/auth/login',{data:login})).status(),200);
  const page=await context.newPage();page.setDefaultTimeout(30000);
  let requested=0;
  await page.route('**/api/notices',r=>r.fulfill({json:{feed:{notices:[],unreadCount:0,unreadImportantCount:0,popupNotice:null}}}));
  await page.route('**/api/journal-images/synthetic-photo',r=>r.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=','base64')}));
  await page.route('**/api/inquiry?team=*',async r=>{
   const response=await r.fetch(),body=await response.json();body.data.session.cycles.unshift(past);body.data.plan.reviewStatus='draft';
   await r.fulfill({json:body});
  });
  await page.route('**/api/**/journals?*',async r=>{
   if(new URL(r.request().url()).searchParams.get('cycleId')!==past.id) return r.continue();
   assert.equal(r.request().method(),'GET');requested++;
   await r.fulfill({json:audience==='student'?{journals:[journal]}:{members:[{id:'demo_student_1',name:'합성 작성자',loginId:'synthetic-only',isActive:false,journals:[journal]}]}});
  });
  if(audience==='teacher') {
   await page.route('**/api/teacher/cycles',r=>r.fulfill({json:{ok:true}}));
   await page.route('**/teacher/team/demo_team_1*',async r=>{
    if(r.request().headers()['rsc']!=='1') return r.continue();
    const response=await r.fetch();const body=await response.text();assert.ok(body.includes('"cycles":['));
    await r.fulfill({response,body:body.replaceAll('"cycles":[','"cycles":['+JSON.stringify(past)+',')});
   });
   await page.goto(base+'/teacher/team/demo_team_1');
   await page.waitForFunction(()=>{const field=document.querySelector('#report-feedback');return field&&!field.disabled;});
   await page.getByRole('button',{name:'회차 안내 저장',exact:true}).click();
  } else await page.goto(base+'/inquiry#plan');
  await page.getByText(past.title,{exact:true}).click();
  const label=audience==='student'?'이 회차의 내 일지와 사진':'이 회차의 개인 일지와 사진';
  await page.getByText(label,{exact:true}).click();
  const history=page.locator('details').filter({has:page.getByText(label,{exact:true})}).last();
  await history.getByText(journal.activities,{exact:true}).waitFor();
  await history.getByText(journal.reflections,{exact:true}).waitFor();
  await history.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0?undefined:new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;}));
  assert.equal(await history.locator('textarea,input').count(),0);
  assert.ok(requested>=1); // Development Strict Mode may mount the read effect twice.
  if(audience==='teacher') await history.getByText('팀에서 제거됨',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('PASS: '+audience+' opens completed-cycle journals and photos read-only at tablet width');
  await context.close();
 }
} finally {await browser.close();}
