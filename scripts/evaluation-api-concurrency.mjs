// Loopback development server with isolated memory DB and synthetic accounts only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { request } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = 'http://127.0.0.1:3107';
const teacher = await request.newContext({ baseURL });
const student = await request.newContext({ baseURL });
try {
  assert.equal((await teacher.post('/api/auth/login', { data: { loginId: 'teacher', password: 'local-editor-regression-only' } })).status(), 200);
  assert.equal((await student.post('/api/auth/login', { data: { loginId: '10901', password: 'student1234' } })).status(), 200);
  const created = await teacher.post('/api/teacher/evaluations', { data: { action: 'create', classNumber: 9, title: '합성 API 동시 저장 검증', optionalItem: 'none' } });
  assert.equal(created.status(), 200, await created.text());
  const { roundId } = await created.json();
  assert.equal((await teacher.post('/api/teacher/evaluations', { data: { action: 'open', roundId } })).status(), 200);
  const read = async () => { const response = await student.get('/api/inquiry/evaluation?teamId=demo_team_1'); assert.equal(response.status(), 200); return (await response.json()).data; };
  const fixture = await read();
  const responses = fixture.round.template.items.map(item => ({ itemId: item.id, value: 3, reason: '' }));
  const self = { action: 'saveSelf', roundId, responses, reflections: ['합성 자기평가 A', '다음 행동'], expectedVersion: null };
  let pair = await Promise.all([student.post('/api/inquiry/evaluation', { data: self }), student.post('/api/inquiry/evaluation', { data: { ...self, reflections: ['합성 자기평가 B', '다음 행동'] } })]);
  assert.deepEqual(pair.map(response => response.status()).sort(), [200, 409]);
  assert.equal((await read()).selfEvaluation.version, 1);
  console.log('PASS: real self evaluation API returns one success and one 409 for simultaneous first saves');
  pair = await Promise.all(['기기 A 수정', '기기 B 수정'].map(text => student.post('/api/inquiry/evaluation', { data: { ...self, expectedVersion: 1, reflections: [text, '다음 행동'] } })));
  assert.deepEqual(pair.map(response => response.status()).sort(), [200, 409]);
  assert.equal((await read()).selfEvaluation.version, 2);
  console.log('PASS: real API rejects a stale self revision and exposes the accepted version');
  const peer = { action: 'savePeer', roundId, evaluateeId: fixture.teammates[0].id, responses, privateEvidence: '', publicComment: '합성 의견', confirmed: true, expectedVersion: null };
  pair = await Promise.all(['기기 A 의견', '기기 B 의견'].map(publicComment => student.post('/api/inquiry/evaluation', { data: { ...peer, publicComment } })));
  assert.deepEqual(pair.map(response => response.status()).sort(), [200, 409]);
  console.log('PASS: real peer evaluation API rejects the competing first save');
  const { expectedVersion, ...oldClient } = self;
  assert.equal((await student.post('/api/inquiry/evaluation', { data: oldClient })).status(), 400);
  console.log('PASS: an API request without a version cannot bypass the conflict check');
  assert.equal((await teacher.post('/api/teacher/evaluations', { data: { action: 'close', roundId } })).status(), 200);
  assert.equal((await student.post('/api/inquiry/evaluation', { data: { ...self, expectedVersion: 2 } })).status(), 403);
  console.log('PASS: closing the round blocks further student writes');
  const management = async () => {
    const response = await teacher.get(`/api/teacher/evaluations?classNumber=9&roundId=${encodeURIComponent(roundId)}`);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const target = (await management()).selected.progress[0];
  pair = await Promise.all(['교사 화면 A', '교사 화면 B'].map(teacherSummary => teacher.post('/api/teacher/evaluations', {
    data: { action: 'saveSummary', roundId, studentId: target.studentId, teacherSummary, expectedVersion: null },
  })));
  assert.deepEqual(pair.map(response => response.status()).sort(), [200, 409]);
  let savedTarget = (await management()).selected.progress.find(item => item.studentId === target.studentId);
  assert.equal(savedTarget.teacherSummaryVersion, 1);
  const retry = await teacher.post('/api/teacher/evaluations', { data: {
    action: 'saveSummary', roundId, studentId: target.studentId,
    teacherSummary: savedTarget.teacherSummary, expectedVersion: null,
  } });
  assert.equal(retry.status(), 200, await retry.text());
  assert.equal((await retry.json()).version, 1);
  pair = await Promise.all(['교사 수정 A', '교사 수정 B'].map(teacherSummary => teacher.post('/api/teacher/evaluations', {
    data: { action: 'saveSummary', roundId, studentId: target.studentId, teacherSummary, expectedVersion: 1 },
  })));
  assert.deepEqual(pair.map(response => response.status()).sort(), [200, 409]);
  savedTarget = (await management()).selected.progress.find(item => item.studentId === target.studentId);
  assert.equal(savedTarget.teacherSummaryVersion, 2);
  console.log('PASS: teacher summary API detects simultaneous saves and keeps a lost-response retry idempotent');
  assert.equal((await teacher.post('/api/teacher/evaluations', { data: {
    action: 'saveSummary', roundId, studentId: target.studentId, teacherSummary: '버전 없는 요청',
  } })).status(), 400);
  const current = await management();
  for (const evaluation of current.selected.peerEvaluations.filter(item => item.publicComment && item.commentReviewStatus === 'pending')) {
    const response = await teacher.post('/api/teacher/evaluations', { data: {
      action: 'reviewComment', evaluationId: evaluation.id, expectedVersion: evaluation.version,
      status: 'approved', redactedPublicComment: evaluation.publicComment,
    } });
    assert.equal(response.status(), 200, await response.text());
  }
  for (const item of current.selected.progress) {
    if (item.studentId === target.studentId) continue;
    const response = await teacher.post('/api/teacher/evaluations', { data: {
      action: 'saveSummary', roundId, studentId: item.studentId,
      teacherSummary: '합성 활동 기록을 바탕으로 작성한 교사 의견', expectedVersion: null,
    } });
    assert.equal(response.status(), 200, await response.text());
  }
  pair = await Promise.all([teacher.post('/api/teacher/evaluations', { data: { action: 'publish', roundId } }), teacher.post('/api/teacher/evaluations', { data: { action: 'publish', roundId } })]);
  assert.deepEqual(pair.map(response => response.status()), [200, 200]);
  assert.equal((await management()).selected.status, 'published');
  assert.equal((await teacher.post('/api/teacher/evaluations', { data: {
    action: 'saveSummary', roundId, studentId: target.studentId, teacherSummary: '공개 뒤 변경', expectedVersion: 2,
  } })).status(), 400);
  assert.equal((await teacher.post('/api/teacher/evaluations', { data: { action: 'reopen', roundId } })).status(), 400);
  console.log('PASS: publication is idempotent and blocks later summary changes or reopening');
} finally { await teacher.dispose(); await student.dispose(); }
