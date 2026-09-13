// Local synthetic browser check. AI endpoints are intercepted; no external AI call is made.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:3107';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  await page.route("**/api/notices", route => route.fulfill({json:{feed:{notices:[],unreadCount:0,unreadImportantCount:0,popupNotice:null}}}));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const login = await context.request.post(`${base}/api/auth/login`, {
    data: { loginId: '10901', password: 'student1234', academicYear: 2026 },
  });
  assert.equal(login.status(), 200);

  let reviewReady = false;
  let decisionSaved = false;
  let decisionRequests = 0;
  const syntheticReview = {
    id: 'synthetic-review',
    snapshotId: 'synthetic-snapshot',
    submissionId: null,
    audience: 'student',
    model: 'synthetic-model',
    promptVersion: 'student-plan-review-v1',
    schemaVersion: 'plan-review-result-v1',
    snapshotContentHash: 'synthetic-hash',
    snapshotDocumentUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    isCurrent: true,
    result: {
      readiness: 'needs_revision',
      summary: '측정 방법을 조금 더 확인해 보세요.',
      strengths: [{ fieldKeys: ['topic'], feedback: '측정 가능한 현상에 초점을 맞췄어요.' }],
      checks: [{
        category: 'feasibility', priority: 'required', fieldKeys: ['method'],
        observation: '측정 간격이 아직 분명하지 않아요.',
        question: '몇 분 간격으로 측정할 수 있나요?',
        suggestion: '팀이 실제로 지킬 수 있는 간격을 정해 보세요.',
      }],
      limitations: ['실험실 기구 보유 여부는 선생님과 확인해야 해요.'],
    },
  };
  const suggestionId = 'synthetic-suggestion-1';
  const syntheticCycleAnalysis = {
    id: 'synthetic-cycle-analysis', cycleId: 'cycle_demo_session_1_1', snapshotId: 'synthetic-cycle-snapshot',
    snapshotContentHash: 'synthetic-cycle-hash', analysisType: 'intermediate', model: 'synthetic-model',
    promptVersion: 'cycle-intermediate-analysis-v1', schemaVersion: 'cycle-analysis-result-v1',
    createdAt: new Date().toISOString(), isCurrent: true,
    decisions: [],
    documents: {
      plan: { formData: { topic: '합성 회차 주제' }, configDefinition: { fields: [{ id: 'topic', label: '연구 주제', kind: 'text' }] } },
      report: { formData: { result: '합성 회차 결과' }, configDefinition: { fields: [{ id: 'result', label: '탐구 결과', kind: 'long_text' }] }, memberRoles: [] },
      materialRequests: [],
    },
    result: {
      overview: '현재 기록에서 다음 회차에 검토할 선택지를 찾았습니다.', inquiryField: '화학', researchType: '비교 실험',
      strengths: [], findings: [], cycleComparison: [], limitations: [],
      suggestions: [{ id: suggestionId, title: '측정 간격 검토', rationale: '같은 기준으로 비교하기 위해 필요합니다.', evidenceIds: ['plan:topic'], feasibleNextStep: '가능한 간격을 정합니다.', safetyNote: '', questionForStudents: '어떤 간격이 가능한가요?' }],
    },
  };

  await page.route(/\/api\/inquiry\?team=/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (reviewReady) body.data.plan.studentAiReview = syntheticReview;
    syntheticCycleAnalysis.decisions = decisionSaved ? [{ id: 'synthetic-decision', suggestionId, decision: 'modified', reason: '수업 시간에 맞게 10분 간격으로 수정한다.', version: 1, updatedAt: new Date().toISOString() }] : [];
    body.data.session.cycles[0].analysis = syntheticCycleAnalysis;
    await route.fulfill({ json: body });
  });
  await page.route('**/api/inquiry/plan-ai-review', async route => {
    assert.equal(route.request().postDataJSON().planId, 'demo_plan_1');
    reviewReady = true;
    await route.fulfill({ json: { review: syntheticReview } });
  });
  let releaseDecision;
  await page.route('**/api/inquiry/cycle-decisions', async route => {
    decisionRequests++;
    const body = route.request().postDataJSON();
    assert.equal(body.suggestionId, suggestionId);
    assert.equal(body.reason, '수업 시간에 맞게 10분 간격으로 수정한다.');
    await new Promise(resolve => { releaseDecision = resolve; });
    decisionSaved = true;
    await route.fulfill({ json: { decision: { id: 'synthetic-decision', version: 1 } } });
  });

  await page.goto(`${base}/inquiry#plan`);
  await page.getByRole('heading', { name: '탐구 회차 분석', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'AI와 계획서 점검', exact: true }).waitFor();
  await page.locator('.team-banner small').filter({ hasText: '1차 탐구' }).waitFor();
  await page.getByRole('button', { name: '임시 저장본 AI 점검', exact: true }).click();
  await page.getByText('측정 방법을 조금 더 확인해 보세요.', { exact: false }).waitFor();
  await page.getByText('몇 분 간격으로 측정할 수 있나요?', { exact: false }).waitFor();
  const reason = page.getByRole('textbox', { name: '선택한 이유', exact: true });
  await reason.fill('수업 시간에 맞게 10분 간격으로 수정한다.');
  await page.reload();
  await reason.waitFor();
  assert.equal(await reason.inputValue(), '수업 시간에 맞게 10분 간격으로 수정한다.');
  assert.equal(decisionRequests, 0, 'typing a decision must not save it automatically');
  await page.getByRole('button', { name: '판단 저장', exact: true }).click();
  while (!releaseDecision) await page.waitForTimeout(50);
  await reason.fill('응답 대기 중 추가로 쓴 판단 이유');
  releaseDecision();
  await page.getByText('AI 제안에 대한 팀의 판단을 저장했습니다.', { exact: true }).waitFor();
  assert.equal(decisionRequests, 1);
  await page.reload();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(el => el.value === '응답 대기 중 추가로 쓴 판단 이유'));
  console.log('PASS: a late decision response preserves newer reasoning through reload');
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log('PASS: cycle label and student AI plan review render at tablet width without calling external AI');

  await context.close();

  const teacher = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  assert.equal((await teacher.request.post(`${base}/api/auth/login`, {
    data: { loginId: 'teacher', password: 'local-editor-regression-only', academicYear: 2026 },
  })).status(), 200);
  const teacherPage = await teacher.newPage();
  teacherPage.on('dialog', dialog => dialog.accept());
  let phase=0;
  const actions=[];
  await teacherPage.route('**/api/teacher/cycles',async route=>{
    const input=route.request().postDataJSON(); actions.push(input);
    assert.equal(input.cycleId,'cycle_demo_session_1_1');
    phase=input.analysisType==='final'?2:1;
    await route.fulfill({json:{ok:true}});
  });
  await teacherPage.route('**/teacher/team/demo_team_1*',async route=>{
    if(!phase || route.request().headers()['rsc']!=='1') return route.continue();
    const response=await route.fetch();let body=await response.text();
    const analysis=phase===2?{...syntheticCycleAnalysis,id:'synthetic-final',analysisType:'final',decisions:[]}:syntheticCycleAnalysis;
    assert.ok(body.includes('"analysis":null'));
    body=body.replaceAll('"analysis":null','"analysis":'+JSON.stringify(analysis));
    if(phase===2) body=body.replaceAll('"analysisHistory":[]','"analysisHistory":'+JSON.stringify([syntheticCycleAnalysis]));
    await route.fulfill({response,body});
  });
  await teacherPage.goto(`${base}/teacher/team/demo_team_1`);
  await teacherPage.getByRole('heading', { name: '탐구 회차 안내', exact: true }).waitFor();
  await teacherPage.getByRole('heading', { name: '탐구 회차 분석', exact: true }).waitFor();
  await teacherPage.getByRole('button', { name: '중간 AI 분석 만들기', exact: true }).waitFor();
  await teacherPage.getByRole('button', { name: '최종 AI 분석 만들기', exact: true }).waitFor();
  await teacherPage.getByRole('button', { name: '회차 안내 저장', exact: true }).waitFor();
  await teacherPage.getByRole('heading', { name: 'AI 검토 보조', exact: true }).waitFor();
  await teacherPage.getByText('승인과 피드백은 선생님이 결정합니다.', { exact: false }).waitFor();
  await teacherPage.getByRole('button', { name: '제출본 AI 검토', exact: true }).waitFor();
  assert.ok(await teacherPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log('PASS: teacher AI review remains a submission-based advisory control');
  await teacherPage.getByRole('button',{name:'중간 AI 분석 만들기',exact:true}).click();
  await teacherPage.getByRole('button',{name:'이 회차에서 최종 분석',exact:true}).click();
  await teacherPage.getByRole('button',{name:'전체 탐구 완료',exact:true}).waitFor();
  await teacherPage.getByText('이전 분석과 학생 판단 보기',{exact:true}).click();
  const history=teacherPage.locator('details').filter({has:teacherPage.getByText('이전 분석과 학생 판단 보기',{exact:true})}).last();
  await history.locator('details > summary').click();
  await history.getByText('수업 시간에 맞게 10분 간격으로 수정한다.',{exact:true}).waitFor();
  assert.equal(await teacherPage.getByRole('button',{name:'다음 회차 시작',exact:true}).count(),0);
  assert.deepEqual(actions.map(a=>a.analysisType),['intermediate','final']);
  assert.ok(await teacherPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  console.log('PASS: teacher can move from intermediate to final in the same cycle and read preserved student decisions');
  await teacher.close();
} finally {
  await browser.close();
}
