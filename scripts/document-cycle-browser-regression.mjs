// Local synthetic UI responses only. Never uses operational records or external AI.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base='http://127.0.0.1:3107';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const kind of ['plan','report']) {
  const context=await browser.newContext({viewport:{width:768,height:1024}});
  assert.equal((await context.request.post(base+'/api/auth/login',{data:{loginId:'10901',password:'student1234'}})).status(),200);
  const documentId=kind==='plan'?'demo_plan_1':'report_demo_session_1';
  const oldKey=`science-document-draft:demo_student_1:${kind}:${documentId}`;
  await context.addInitScript(({oldKey})=>sessionStorage.setItem(oldKey,JSON.stringify({purpose:{value:'회차 불명 이전 글',baseValue:'',version:1,saved:false}})),{oldKey});
  const page=await context.newPage();page.setDefaultTimeout(20000);
  await page.route('**/api/notices',route=>route.fulfill({json:{feed:{notices:[],unreadCount:0,unreadImportantCount:0,popupNotice:null}}}));
  let ordinal=1,writes=0;
  await page.route('**/api/inquiry?team=*',async route=>{
   const response=await route.fetch();const body=await response.json();
   body.data.session.cycle={...body.data.session.cycle,id:'synthetic-cycle-'+ordinal,title:ordinal+'차 합성 탐구',status:'active'};
   body.data.plan.reviewStatus='approved';body.data.plan.formData={};body.data.report.formData={};
   body.data.plan.configVersionId=null;body.data.report.configVersionId=null;
   await route.fulfill({json:body});
  });
  await page.route('**/api/inquiry/'+kind+'/lock',route=>route.fulfill({json:{ok:true}}));
  await page.route('**/api/inquiry/'+kind,route=>{writes++;return route.abort();});
  await page.goto(base+'/inquiry#'+kind);
  const field=page.locator('#'+kind+'-purpose');
  await page.waitForFunction(()=>document.body.textContent.includes('1차 합성 탐구'));
  await field.waitFor();assert.equal(await field.inputValue(),'');
  await page.getByText('이전 버전에서 작성한 미저장 글 보기',{exact:true}).click();
  await page.getByText('회차 불명 이전 글',{exact:true}).waitFor();
  await field.fill('첫 회차의 미저장 글');
  ordinal=2;
  await page.waitForFunction(()=>document.body.textContent.includes('2차 합성 탐구'));
  assert.equal(await field.inputValue(),'');
  await field.fill('둘째 회차의 미저장 글');
  ordinal=1;
  await page.waitForFunction(()=>document.body.textContent.includes('1차 합성 탐구'));
  await page.waitForFunction(({kind})=>document.querySelector('#'+kind+'-purpose')?.value==='첫 회차의 미저장 글',{kind});
  await page.reload();
  await page.waitForFunction(({kind})=>document.querySelector('#'+kind+'-purpose')?.value==='첫 회차의 미저장 글',{kind});
  assert.equal(writes,0);assert.ok(await page.evaluate(key=>Boolean(sessionStorage.getItem(key)),oldKey));
  console.log('PASS: '+kind+' separates cycle drafts, recovers on reload, preserves legacy draft without auto-insertion or server writes');
  await context.close();
 }
} finally {await browser.close();}
