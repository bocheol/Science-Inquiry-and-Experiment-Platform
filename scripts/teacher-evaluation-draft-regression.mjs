// Local synthetic accounts only. Verifies teacher recovery drafts and conflicts in Chrome.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:3107';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const teacherContext = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const studentContext = await browser.newContext();
  assert.equal((await teacherContext.request.post(`${base}/api/auth/login`, { data: { loginId: 'teacher', password: 'local-editor-regression-only' } })).status(), 200);
  assert.equal((await studentContext.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234' } })).status(), 200);
  const created = await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: { action: 'create', classNumber: 9, title: '교사 초안 복구 검증', optionalItem: 'none' } });
  assert.equal(created.status(), 200, await created.text());
  const { roundId } = await created.json();
  assert.equal((await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: { action: 'open', roundId } })).status(), 200);
  const studentRead = await studentContext.request.get(`${base}/api/inquiry/evaluation?teamId=demo_team_1`);
  assert.equal(studentRead.status(), 200, await studentRead.text());
  const fixture = (await studentRead.json()).data;
  const peerResponses = fixture.round.peerTemplate.items.map(item => ({ itemId: item.id, value: 3, reason: '' }));
  const peerSaved = await studentContext.request.post(`${base}/api/inquiry/evaluation`, { data: {
    action: 'savePeer', roundId, evaluateeId: fixture.teammates[0].id, responses: peerResponses,
    privateEvidence: '', publicComment: '학생이 작성한 합성 공개 의견', confirmed: true, expectedVersion: null,
  } });
  assert.equal(peerSaved.status(), 200, await peerSaved.text());
  assert.equal((await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: { action: 'close', roundId } })).status(), 200);

  const getManagement = async () => {
    const response = await teacherContext.request.get(`${base}/api/teacher/evaluations?classNumber=9&roundId=${encodeURIComponent(roundId)}`);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  let management = await getManagement();
  const evaluation = management.selected.peerEvaluations.find(item => item.publicComment);
  const student = management.selected.progress[0];
  assert.ok(evaluation && student);

  const page = await teacherContext.newPage();
  const pageErrors = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${base}/teacher/evaluations`);
  const selectRound = async () => {
    const select = page.getByLabel('평가 회차');
    if (await select.inputValue() !== roundId) await select.selectOption(roundId);
    await page.getByRole('heading', { name: '교사 초안 복구 검증' }).waitFor();
  };
  await selectRound();
  const commentCard = page.locator('.peer-review-card').first();
  const commentInput = commentCard.locator('textarea');
  const summaryCard = page.locator('.summary-editor').filter({ hasText: student.name });
  const summaryInput = summaryCard.locator('textarea');
  await commentInput.fill('내가 저장하지 않은 검토 문장');
  await summaryInput.fill('내가 저장하지 않은 종합 의견');
  await page.goto('about:blank');
  await page.goBack();
  await page.locator('.teacher-evaluation-manager').waitFor();
  await selectRound();
  assert.equal(await page.locator('.peer-review-card').first().locator('textarea').inputValue(), '내가 저장하지 않은 검토 문장');
  assert.equal(await page.locator('.summary-editor').filter({ hasText: student.name }).locator('textarea').inputValue(), '내가 저장하지 않은 종합 의견');
  console.log('PASS: teacher review and summary drafts survive leaving the site and returning');

  const otherSummary = await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: {
    action: 'saveSummary', roundId, studentId: student.studentId,
    teacherSummary: '다른 교사가 저장한 종합 의견', expectedVersion: null,
  } });
  assert.equal(otherSummary.status(), 200, await otherSummary.text());
  const otherReview = await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: {
    action: 'reviewComment', evaluationId: evaluation.id, expectedVersion: evaluation.version,
    status: 'approved', redactedPublicComment: '다른 교사가 저장한 검토 문장',
  } });
  assert.equal(otherReview.status(), 200, await otherReview.text());
  await page.reload();
  await selectRound();
  const conflictedComment = page.locator('.peer-review-card').first();
  const conflictedSummary = page.locator('.summary-editor').filter({ hasText: student.name });
  await conflictedComment.getByText('최신 저장 내용과 내 초안을 비교해 주세요.').waitFor();
  await conflictedSummary.getByText('최신 저장 내용과 내 초안을 비교해 주세요.').waitFor();
  assert.match(await conflictedComment.textContent(), /내가 저장하지 않은 검토 문장/);
  assert.match(await conflictedComment.textContent(), /다른 교사가 저장한 검토 문장/);
  assert.match(await conflictedSummary.textContent(), /내가 저장하지 않은 종합 의견/);
  assert.match(await conflictedSummary.textContent(), /다른 교사가 저장한 종합 의견/);
  await conflictedComment.getByRole('button', { name: '내 작성 내용으로 계속' }).click();
  await conflictedSummary.getByRole('button', { name: '내 작성 내용으로 계속' }).click();
  management = await getManagement();
  assert.equal(management.selected.peerEvaluations.find(item => item.id === evaluation.id).redactedPublicComment, '다른 교사가 저장한 검토 문장');
  assert.equal(management.selected.progress.find(item => item.studentId === student.studentId).teacherSummary, '다른 교사가 저장한 종합 의견');
  console.log('PASS: choosing local teacher drafts does not write them to the server');

  await page.getByRole('button', { name: '결과 공개' }).click();
  await page.locator('.teacher-evaluation-manager .error-box').filter({ hasText: '저장하지 않은 검토 문장이나 종합 피드백이 있습니다.' }).waitFor();
  assert.equal((await getManagement()).selected.status, 'reviewing');
  console.log('PASS: the current teacher tab cannot publish while it has unsaved review drafts');

  await Promise.all([
    conflictedComment.getByRole('button', { name: '원문/최소 가림 승인' }).click(),
    conflictedSummary.getByRole('button', { name: '피드백 저장' }).click(),
  ]);
  await page.waitForTimeout(600);
  management = await getManagement();
  assert.equal(management.selected.peerEvaluations.find(item => item.id === evaluation.id).redactedPublicComment, '내가 저장하지 않은 검토 문장');
  assert.equal(management.selected.peerEvaluations.find(item => item.id === evaluation.id).version, evaluation.version + 2);
  assert.equal(management.selected.progress.find(item => item.studentId === student.studentId).teacherSummary, '내가 저장하지 않은 종합 의견');
  assert.equal(management.selected.progress.find(item => item.studentId === student.studentId).teacherSummaryVersion, 2);
  console.log('PASS: rebased teacher drafts write only after their explicit save buttons');

  for (const item of management.selected.progress) {
    if (item.teacherSummary) continue;
    const response = await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: {
      action: 'saveSummary', roundId, studentId: item.studentId,
      teacherSummary: '합성 활동 기록을 바탕으로 작성한 교사 의견', expectedVersion: item.teacherSummaryVersion,
    } });
    assert.equal(response.status(), 200, await response.text());
  }
  const published = await teacherContext.request.post(`${base}/api/teacher/evaluations`, { data: { action: 'publish', roundId } });
  assert.equal(published.status(), 200, await published.text());
  assert.deepEqual(pageErrors, []);
  await teacherContext.close();
  await studentContext.close();
} finally {
  await browser.close();
}
