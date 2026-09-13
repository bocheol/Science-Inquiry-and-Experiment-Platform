// Uses synthetic props and intercepts every API request. No database or external AI.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const fixtureDir = resolve(root, 'src/app/codex-feedback-regression');
const fixture = resolve(fixtureDir, 'page.tsx');
const base = 'http://127.0.0.1:3117';
const fixtureSource = `"use client";
import { useState } from 'react';
import { TeacherTeamReview } from '@/components/teacher-team-review';
import type { InquiryData } from '@/lib/inquiry-data';
export default function Fixture() {
  const [version, setVersion] = useState(1);
  const [stale, setStale] = useState(false);
  const data = {
    team: {id:'fixture-team',name:'합성검증팀',classNumber:1,teamNumber:1,leaderUserId:null},
    session: {id:'fixture-session',stage:'PLANNING',selectedTopic:'합성 탐구',interestInput:null,aiBusy:false,topicSuggestions:[],
      cycle:{id:'fixture-cycle',ordinal:1,title:'탐구',status:'active',origin:'configured',startedAt:null,endedAt:null},cycles:[]},
    members:[],messages:[],materials:null,customTabs:[],clubFeatures:{materials:false,selfEvaluation:false,peerEvaluation:false,exam:false},
    plan:{id:'fixture-plan',formData:{method:'합성 측정 계획'},reviewStatus:'pending',teacherFeedback:null,updatedAt:'2026-09-08T00:00:00Z',
      locks:[],history:[],configVersionId:null,description:'',fields:[{id:'method',label:'실험 방법',kind:'long_text'}],
      latestSubmission:{id:'submission-'+version,planId:'fixture-plan',snapshotId:'snapshot-'+version,cycleId:'fixture-cycle',submissionNumber:version,source:'submission',reviewStatus:'pending',teacherFeedback:null,submittedAt:'2026-09-08T00:00:00Z'},
      latestSubmissionSnapshot:null,studentAiReview:null,teacherAiReview:{id:'review-'+version,snapshotId:stale?'old-snapshot':'snapshot-'+version,submissionId:'submission-'+version,audience:'teacher',createdAt:'2026-09-08T00:00:00Z',result:{
        readiness:'needs_revision',summary:'측정 조건을 보완해 주세요.',strengths:[],limitations:[],checks:[
          {fieldKeys:['method'],category:'missing',priority:'required',observation:'측정 간격이 없습니다.',suggestion:'측정 간격을 정해 주세요.',question:'몇 분마다 측정하나요?'},
          {fieldKeys:['method'],category:'evidence',priority:'recommended',observation:'통제 조건이 없습니다.',suggestion:'통제 조건을 적어 주세요.',question:'무엇을 같게 유지하나요?'}]}}},
    report:{id:'fixture-report',reviewVersion:0,formData:{},status:'draft',teacherFeedback:null,updatedAt:'2026-09-08T00:00:00Z',roles:[],locks:[],history:[],configVersionId:null,description:'',fields:[]}
  } as unknown as InquiryData;
  return <main><button onClick={()=>setVersion(v=>v===1?2:1)}>합성 제출본 전환</button><button onClick={()=>setStale(v=>!v)}>합성 오래된 AI 전환</button><TeacherTeamReview data={data} currentUserId="fixture-teacher" /></main>;
}`;

let server, browser, created = false;
let serverLog = '';
try {
  await mkdir(fixtureDir); // Refuse to overwrite another task's fixture.
  created = true;
  await writeFile(fixture, fixtureSource);
  const env = { ...process.env, SESSION_SECRET:'synthetic-feedback-only', BOOTSTRAP_TEACHER_PASSWORD:'synthetic-feedback-only' };
  for (const key of ['DATABASE_URL','INSTANCE_UNIX_SOCKET','DB_USER','DB_PASSWORD','DB_NAME','OPENAI_API_KEY','GOOGLE_SERVICE_ACCOUNT_JSON','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','K_SERVICE','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT']) env[key]='';
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3117'], {cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  for (const stream of [server.stdout,server.stderr]) stream.on('data', d=>{ serverLog=(serverLog+d).slice(-5000); });
  for (let attempt=0; attempt<120 && !serverLog.includes('Ready'); attempt++) {
    if(server.exitCode!==null) throw new Error(serverLog);
    await new Promise(r=>setTimeout(r,500));
  }
  if(!serverLog.includes('Ready')) throw new Error('Local fixture server did not become ready');
  browser = await chromium.launch({channel:'chrome',headless:true});
  const context = await browser.newContext({viewport:{width:768,height:1024}});
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const sent=[];
  let failSend=false;
  await page.route('**/api/**', async route=>{
    const url=route.request().url();
    if(url.endsWith('/api/teacher/plans/review')) {
      sent.push(route.request().postDataJSON());
      return failSend ? route.abort('failed') : route.fulfill({json:{ok:true}});
    }
    if(route.request().method()!=='GET') throw new Error('Unexpected write: '+url);
    return route.fulfill({json:{sources:[],history:[],jobs:[],members:[],cycle:{id:'fixture-cycle',status:'active'}}});
  });
  await page.goto(base+'/codex-feedback-regression',{timeout:120000});
  const field=page.locator('#feedback');
  await field.fill('교사가 먼저 쓴 문장');
  await page.getByRole('button',{name:'피드백에 반영',exact:true}).first().click();
  const first=await field.inputValue();
  assert.ok(first.startsWith('교사가 먼저 쓴 문장\n\n[실험 방법]'));
  assert.ok(first.includes('측정 간격을 정해 주세요.'));
  assert.equal(sent.length,0);
  assert.equal(await page.getByRole('button',{name:'피드백에 반영됨',exact:true}).isDisabled(),true);
  await field.fill(first+'\n교사가 추가로 다듬은 문장');
  await page.getByRole('button',{name:'피드백에 반영',exact:true}).click();
  const composed=await field.inputValue();
  assert.ok(composed.includes('교사가 추가로 다듬은 문장'));
  assert.ok(composed.includes('통제 조건을 적어 주세요.'));
  assert.equal(sent.length,0);
  await page.reload();
  await field.waitFor();
  await page.waitForFunction(()=>document.querySelector('#feedback')?.value.includes('통제 조건을 적어 주세요.'));
  assert.equal(await field.inputValue(),composed);
  assert.equal(await page.getByRole('button',{name:'피드백에 반영됨',exact:true}).count(),2);
  await page.getByRole('button',{name:'합성 제출본 전환'}).click();
  assert.equal(await field.inputValue(),'');
  await page.getByRole('button',{name:'합성 제출본 전환'}).click();
  await page.waitForFunction(()=>document.querySelector('#feedback')?.value.includes('통제 조건을 적어 주세요.'));
  assert.equal(await field.inputValue(),composed);
  await page.getByRole('button',{name:'합성 오래된 AI 전환'}).click();
  await page.getByText('이 AI 검토는 현재 검토할 제출본과 다릅니다.',{exact:false}).waitFor();
  assert.equal(await field.inputValue(),composed);
  await page.getByRole('button',{name:'합성 오래된 AI 전환'}).click();
  failSend=true;
  await page.getByRole('button',{name:'수정 요청 보내기',exact:true}).click();
  await page.getByText('연결이 끊겼거나 응답이 늦습니다.',{exact:false}).first().waitFor();
  assert.equal(await field.inputValue(),composed);
  failSend=false;
  await page.getByRole('button',{name:'수정 요청 보내기',exact:true}).click();
  await page.getByText('학생 팀에 수정 요청을 보냈습니다.',{exact:true}).first().waitFor();
  assert.equal(sent.length,2);
  assert.equal(sent[1].feedback,composed);
  assert.equal(sent[1].expected.submissionId,'submission-1');
  assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  console.log('PASS: compose, preserve edits, deduplicate, recover, isolate submissions, stale AI warning, failed-send recovery, explicit-send payload; 768px layout');
} finally {
  // Remove the temporary route before waiting on browser/child shutdown.
  if(created) { await unlink(fixture).catch(()=>{}); await rmdir(fixtureDir); }
  const bounded = (promise) => Promise.race([promise, new Promise(resolve=>{ const timer=setTimeout(resolve,5000); timer.unref(); })]);
  await bounded(browser?.close());
  if(server && server.exitCode===null) {
    if(process.platform==='win32') await bounded(new Promise(resolve=>spawn('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('close',resolve)));
    else server.kill('SIGTERM');
    server.stdout.destroy(); server.stderr.destroy(); server.stdin.destroy(); server.unref();
  }
}
