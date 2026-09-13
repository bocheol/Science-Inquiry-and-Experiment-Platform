// Local synthetic accounts and intercepted evaluation/custom-tab data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:3107';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let debugPage;
try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  debugPage = page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const login = await context.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234' } });
  assert.equal(login.status(), 200);
  const item = { id: 'observed', prompt: '관찰 기록을 남겼다', levels: { 1: '기록 없음', 2: '일부 기록', 3: '꾸준한 기록', 4: '근거와 함께 기록' } };
  const template = { items: [item], selfReflectionQuestions: ['실제로 한 일과 근거', '다음에 바꿀 행동'] };
  const data = { round: { id: 'synthetic-round', title: '복구 검증 평가', status: 'open', template, peerTemplate: template }, teammates: [{ id: 'peer-a', name: '예시 A', loginId: '10001' }, { id: 'peer-b', name: '예시 B', loginId: '10002' }], selfEvaluation: null, peerEvaluations: [], result: null };
  const tab = { id: 'synthetic-custom-tab', title: '복구 검증 탭', definition: { responseMode: 'team', workflow: 'review', fields: [{ id: 'note', kind: 'long_text', label: '검증 메모' }] } };
  let failSave = false, failLoad = false, gate = null, finish;
  let custom = { responseData: {}, status: 'draft', teacherFeedback: null, version: null };
  const sent = [];
  await page.route('**/api/inquiry?team=*', async route => {
    const response = await route.fetch();
    const result = await response.json();
    result.data.customTabs = [tab];
    await route.fulfill({ json: result });
  });
  await page.route('**/api/inquiry/evaluation**', async route => {
    if (route.request().method() === 'GET') return failLoad ? route.abort('internetdisconnected') : route.fulfill({ json: { data } });
    const body = route.request().postDataJSON(); sent.push(body);
    if (failSave) return route.abort('internetdisconnected');
    if (gate) await gate;
    const previous = body.action === 'saveSelf' ? data.selfEvaluation : data.peerEvaluations.find(value => value.evaluateeId === body.evaluateeId);
    if (body.expectedVersion !== (previous?.version ?? null)) return route.fulfill({ status: 409, json: { message: '다른 곳에서 저장했습니다.' } });
    const version = (previous?.version ?? 0) + 1;
    if (body.action === 'saveSelf') data.selfEvaluation = { ...body, submittedAt: new Date().toISOString(), version };
    else { data.peerEvaluations = data.peerEvaluations.filter(value => value.evaluateeId !== body.evaluateeId); data.peerEvaluations.push({ ...body, submittedAt: new Date().toISOString(), version }); }
    await route.fulfill({ json: { ok: true, version } });
  });
  await page.route('**/api/club-tabs**', async route => {
    if (route.request().method() === 'GET') return failLoad ? route.abort('internetdisconnected') : route.fulfill({ json: custom });
    const body = route.request().postDataJSON(); sent.push(body);
    if (failSave) return route.abort('internetdisconnected');
    if (gate) await gate;
    if (body.expectedVersion !== custom.version) return route.fulfill({ status: 409, json: { message: '다른 곳에서 저장했습니다.' } });
    custom = { responseData: body.responseData, status: body.submit ? 'submitted' : 'draft', teacherFeedback: null, version: (custom.version ?? 0) + 1 };
    await route.fulfill({ json: { ok: true, version: custom.version } });
  });
  const openEvaluation = async () => { await page.getByRole('button', { name: '⭐ 자기·동료평가', exact: true }).click(); await page.getByRole('button', { name: /나의 자기평가/ }).waitFor(); };
  const peer = async () => { await page.getByRole('button', { name: /^팀원 평가/ }).click(); await page.getByRole('button', { name: /^예시 A/ }).waitFor(); };
  const openCustom = async () => { await page.getByRole('button', { name: '📌 복구 검증 탭', exact: true }).click(); await page.getByRole('textbox', { name: /^검증 메모/ }).waitFor(); };
  const leave = () => page.getByRole('button', { name: '💬 이론 탐구', exact: true }).click();
  const reflection = () => page.getByRole('textbox', { name: /^실제로 한 일과 근거/ });
  const comment = () => page.getByPlaceholder('직접 본 도움이 된 행동과 다음 활동에 도움이 될 구체적인 제안을 적어 주세요.');
  const waitPost = (path) => page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(path));
  const hold = () => { gate = new Promise(resolve => { finish = resolve; }); };
  const release = () => { finish(); gate = null; };
  const networkError = () => page.getByRole('main').getByText('연결이 끊겼거나 응답이 늦습니다. 작성 내용은 유지되며 저장을 다시 시도할 수 있습니다.', { exact: true }).waitFor();
  await page.goto(`${base}/inquiry`); await openEvaluation();
  await reflection().fill('미제출 자기평가'); await page.getByLabel('다음에 바꿀 행동', { exact: true }).fill('다음 행동');
  await peer(); await comment().fill('A에 대한 초안');
  await page.getByRole('button', { name: /^예시 B/ }).click(); await comment().fill('B에 대한 초안');
  await page.getByRole('button', { name: /^예시 A/ }).click(); assert.equal(await comment().inputValue(), 'A에 대한 초안');
  await page.reload(); await openEvaluation(); assert.equal(await reflection().inputValue(), '미제출 자기평가');
  await peer(); assert.equal(await comment().inputValue(), 'A에 대한 초안');
  await page.getByRole('button', { name: /^예시 B/ }).click(); assert.equal(await comment().inputValue(), 'B에 대한 초안');
  assert.equal(sent.length, 0);
  console.log('PASS: self and separate peer drafts survive target changes and reload without server writes');

  await page.getByRole('button', { name: /나의 자기평가/ }).click(); hold();
  let posting = waitPost('/api/inquiry/evaluation'); await page.getByRole('button', { name: '자기평가 저장', exact: true }).click(); await posting;
  await reflection().fill('자기평가 저장 중 추가 입력'); release();
  await page.getByRole('button', { name: '자기평가 수정 저장', exact: true }).waitFor();
  assert.equal(await reflection().inputValue(), '자기평가 저장 중 추가 입력');
  assert.equal(data.selfEvaluation.reflections[0], '미제출 자기평가');
  await page.reload(); await openEvaluation(); assert.equal(await reflection().inputValue(), '자기평가 저장 중 추가 입력');
  console.log('PASS: self save response and refreshed submission timestamp preserve newer typing');

  await peer(); hold();
  await page.getByRole('checkbox').check(); posting = waitPost('/api/inquiry/evaluation');
  await page.getByRole('button', { name: '이 팀원 평가 저장', exact: true }).click(); await posting;
  await page.getByRole('button', { name: /^예시 B/ }).click(); await page.getByRole('button', { name: /^예시 A/ }).click();
  await comment().fill('A의 새 초안'); release();
  await page.getByRole('button', { name: '이 팀원 평가 수정 저장', exact: true }).waitFor();
  assert.equal(await comment().inputValue(), 'A의 새 초안');
  await page.reload(); await openEvaluation(); await peer(); assert.equal(await comment().inputValue(), 'A의 새 초안');
  console.log('PASS: response from an unmounted peer form cannot delete a newer draft');

  failSave = true; await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '이 팀원 평가 수정 저장', exact: true }).click(); await networkError();
  assert.equal(await page.getByRole('button', { name: '이 팀원 평가 수정 저장', exact: true }).isEnabled(), true);
  failSave = false; await page.getByRole('button', { name: '이 팀원 평가 수정 저장', exact: true }).click();
  await page.getByRole('main').getByText('예시 A 학생에 대한 평가를 저장했습니다.', { exact: true }).waitFor();
  assert.equal(data.peerEvaluations.find(value => value.evaluateeId === 'peer-a').publicComment, 'A의 새 초안');
  console.log('PASS: peer network failure retains writing, unlocks save, and allows explicit retry');

  data.round.status = 'closed'; await page.reload(); await openEvaluation();
  assert.equal(await reflection().inputValue(), '미제출 자기평가'); assert.equal(await reflection().isDisabled(), true);
  await peer(); await page.getByRole('button', { name: /^예시 B/ }).click();
  await page.getByText('이 팀원에게 제출한 평가가 없습니다.', { exact: false }).waitFor();
  assert.equal(await comment().count(), 0);
  data.round.status = 'open'; await page.reload(); await openEvaluation(); assert.equal(await reflection().inputValue(), '자기평가 저장 중 추가 입력');
  data.round.id = 'different-round'; await page.reload(); await openEvaluation(); assert.equal(await reflection().inputValue(), '미제출 자기평가');
  data.round.id = 'synthetic-round';
  console.log('PASS: closed evaluations show submitted data; drafts survive reopening and do not leak to a different round');

  failLoad = true; await leave(); await page.getByRole('button', { name: '⭐ 자기·동료평가', exact: true }).click();
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
  failLoad = false; await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  assert.equal(await reflection().inputValue(), '자기평가 저장 중 추가 입력');
  failLoad = true;
  await page.getByRole('button', { name: '자기평가 수정 저장', exact: true }).click();
  await page.getByText('저장은 완료했지만 최신 평가 상태를 불러오지 못했습니다. 잠시 뒤 다시 확인해 주세요.', { exact: true }).waitFor();
  assert.equal(await reflection().inputValue(), '자기평가 저장 중 추가 입력');
  assert.equal(await page.getByRole('button', { name: '자기평가 수정 저장', exact: true }).isEnabled(), true);
  failLoad = false;
  console.log('PASS: evaluation load retry recovers drafts and post-save refresh failure does not hide the editor');

  await openCustom(); await page.getByRole('textbox', { name: /^검증 메모/ }).fill('추가 탭 초안');
  const count = sent.length; await leave(); await openCustom(); assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '추가 탭 초안');
  await page.route('https://draft-return.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>External page fixture</h1>' }));
  await page.goto('https://draft-return.invalid/'); await page.goBack(); await openCustom();
  assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '추가 탭 초안'); assert.equal(sent.length, count);
  console.log('PASS: custom draft survives internal and same-tab external navigation without server writes');

  failLoad = true; await leave(); await openCustom();
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '추가 탭 초안');
  assert.equal(await page.getByRole('button', { name: '임시 저장', exact: true }).isDisabled(), true);
  failLoad = false; await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '임시 저장' && !b.disabled));
  failSave = true; await page.getByRole('button', { name: '임시 저장', exact: true }).click(); await networkError();
  assert.equal(await page.getByRole('button', { name: '임시 저장', exact: true }).isEnabled(), true);
  failSave = false;
  console.log('PASS: custom load/save failures keep the draft and offer a working explicit retry');

  hold(); posting = waitPost('/api/club-tabs'); await page.getByRole('button', { name: '임시 저장', exact: true }).click(); await posting;
  await page.getByRole('textbox', { name: /^검증 메모/ }).fill('추가 탭 저장 중 추가 입력'); release();
  await page.getByRole('button', { name: '임시 저장', exact: true }).waitFor();
  assert.equal(custom.responseData.note, '추가 탭 초안');
  await page.reload(); await openCustom(); assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '추가 탭 저장 중 추가 입력');
  await page.getByRole('button', { name: '교사 검토 요청', exact: true }).click(); await page.getByRole('button', { name: '검토 요청됨', exact: true }).waitFor();
  assert.equal(custom.responseData.note, '추가 탭 저장 중 추가 입력');
  console.log('PASS: custom save captures button-time contents and preserves later edits for explicit review submission');

  await page.getByRole('textbox', { name: /^검증 메모/ }).fill('내 공동 탭 초안');
  custom = { ...custom, responseData: { note: '다른 학생의 저장 내용' }, version: custom.version + 1 };
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  await page.getByText('다른 학생의 저장 내용', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '내 공동 탭 초안');
  const beforeChoice = sent.length;
  await page.getByRole('button', { name: '내 작성 내용으로 계속', exact: true }).click();
  assert.equal(sent.length, beforeChoice);
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await page.getByRole('main').getByText('저장하지 않은 작성 내용이 이 탭에 보관되어 있습니다.', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(custom.responseData.note, '내 공동 탭 초안');
  console.log('PASS: custom conflict preserves both texts and choosing mine requires an explicit save');

  await openEvaluation();
  await reflection().fill('다른 기기와 비교할 내 자기평가');
  data.selfEvaluation = { ...data.selfEvaluation, reflections: ['다른 기기의 자기평가', '다른 기기 행동'], version: data.selfEvaluation.version + 1 };
  await page.getByRole('button', { name: '자기평가 수정 저장', exact: true }).click();
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  assert.equal(await reflection().inputValue(), '다른 기기와 비교할 내 자기평가');
  await page.reload(); await openEvaluation();
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  const selfCount = sent.length;
  await page.getByRole('button', { name: '최신 저장 내용 사용', exact: true }).click();
  assert.equal(await reflection().inputValue(), '다른 기기의 자기평가'); assert.equal(sent.length, selfCount);
  console.log('PASS: self conflict and its original base survive reload; choosing server data sends no write');

  await peer(); await comment().fill('동료평가 내 의견');
  const target = data.peerEvaluations.find(value => value.evaluateeId === 'peer-a');
  target.publicComment = '다른 기기의 동료평가'; target.version++;
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '이 팀원 평가 수정 저장', exact: true }).click();
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  assert.equal(await comment().inputValue(), '동료평가 내 의견');
  await page.getByRole('button', { name: '내 작성 내용으로 계속', exact: true }).click();
  await page.getByRole('button', { name: '이 팀원 평가 수정 저장', exact: true }).click();
  await page.getByRole('main').getByText('저장하지 않은 작성 내용이 이 탭에 보관되어 있습니다.', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(data.peerEvaluations.find(value => value.evaluateeId === 'peer-a').publicComment, '동료평가 내 의견');
  console.log('PASS: peer conflict compares only my evaluation and saves the chosen draft explicitly');

  await openCustom(); await page.getByRole('textbox', { name: /^검증 메모/ }).fill('버전 없는 이전 초안');
  await page.evaluate(() => { const key = Object.keys(sessionStorage).find(key => key.startsWith('science-custom-draft:')); const draft = JSON.parse(sessionStorage.getItem(key)); delete draft.baseVersion; sessionStorage.setItem(key, JSON.stringify(draft)); });
  await page.reload(); await openCustom();
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '버전 없는 이전 초안');
  await page.getByRole('button', { name: '내 작성 내용으로 계속', exact: true }).click();
  console.log('PASS: legacy recovery drafts without a base version are preserved and require comparison');

  await page.clock.install();
  await page.getByRole('textbox', { name: /^검증 메모/ }).fill('응답 시간 초과 중 작성');
  hold(); posting = waitPost('/api/club-tabs'); await page.getByRole('button', { name: '임시 저장', exact: true }).click(); await posting;
  await page.clock.fastForward(31_000); await networkError();
  assert.equal(await page.getByRole('button', { name: '임시 저장', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('textbox', { name: /^검증 메모/ }).inputValue(), '응답 시간 초과 중 작성');
  release();
  console.log('PASS: a request exceeding 30 seconds unlocks save and keeps the recovery draft');
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
} catch (error) { console.error(await debugPage?.getByRole('main').innerText()); throw error; }
finally { await browser.close(); }
