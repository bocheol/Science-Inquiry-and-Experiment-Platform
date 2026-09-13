// Local synthetic accounts only. Never point this check at the public service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:3107';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  await page.route("**/api/notices", route => route.fulfill({json:{feed:{notices:[],unreadCount:0,unreadImportantCount:0,popupNotice:null}}}));
  const login = await context.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234', academicYear: 2026 } });
  assert.equal(login.status(), 200, 'local fixture login');
  const fixture = (await (await context.request.get(`${base}/api/inquiry?team=demo_team_1`)).json()).data;
  const lockProbe = await context.request.post(`${base}/api/inquiry/plan/lock`, { data: { cycleId: 'cycle_demo_session_1_1', planId: fixture.plan.id, fieldKey: 'topic', action: 'acquire' } });
  assert.equal(lockProbe.status(), 200, `local fixture lock: ${await lockProbe.text()}`);
  await page.goto(`${base}/inquiry#plan`);
  await page.locator('#plan-topic').waitFor();
  let finishSave;
  const gate = new Promise((resolve) => { finishSave = resolve; });
  await page.route('**/api/inquiry/plan', async (route) => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON().fieldKey === 'topic') await gate;
    await route.continue();
  });
  await page.locator('#plan-topic').fill(`Synthetic topic for editor regression ${Date.now()}`);
  await page.locator('#plan-motivation').fill('Value captured at the manual save click');
  const saving = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith('/api/inquiry/plan'));
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await saving;
  await page.locator('#plan-motivation').fill('Unsaved text in the next field must survive');
  const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/api/inquiry/plan'));
  finishSave();
  await saved;
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('#plan-motivation').inputValue(), 'Unsaved text in the next field must survive', 'late save of previous field must not erase the current field');
  for (let n = 0; n < 80 && await page.getByRole('button', { name: '임시 저장', exact: true }).isDisabled(); n++) await page.waitForTimeout(100);
  const snapshot = (await (await context.request.get(`${base}/api/inquiry?team=demo_team_1`)).json()).data.plan;
  assert.equal(snapshot.formData.motivation, 'Value captured at the manual save click', 'queued fields must use the click snapshot');
  console.log('PASS: manual save captures all fields at the click and preserves later typing');
  await context.close();
  for (const kind of ['plan', 'report']) {
    if (kind === 'report') {
      const submittingStudent = await browser.newContext();
      assert.equal((await submittingStudent.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234', academicYear: 2026 } })).status(), 200);
      for (const [fieldKey, value] of [['field', '화학'], ['purpose', '합성 회귀 목적'], ['method', '합성 회귀 방법'], ['expectedResult', '합성 회귀 예상 결과']]) {
        const completed = await submittingStudent.request.patch(`${base}/api/inquiry/plan`, { data: { cycleId: 'cycle_demo_session_1_1', planId: 'demo_plan_1', fieldKey, value } });
        assert.equal(completed.status(), 200, `complete required ${fieldKey}: ${await completed.text()}`);
      }
      const submittedPlan = await submittingStudent.request.post(`${base}/api/inquiry/plan`, { data: { cycleId: 'cycle_demo_session_1_1', planId: 'demo_plan_1', action: 'submit' } });
      assert.equal(submittedPlan.status(), 200, `submit fixed plan snapshot before teacher approval: ${await submittedPlan.text()}`);
      const submitted = (await (await submittingStudent.request.get(`${base}/api/inquiry?team=demo_team_1`)).json()).data;
      await submittingStudent.close();
      const teacher = await browser.newContext();
      assert.equal((await teacher.request.post(`${base}/api/auth/login`, { data: { loginId: 'teacher', password: 'local-editor-regression-only', academicYear: 2026 } })).status(), 200);
      assert.equal((await teacher.request.post(`${base}/api/teacher/plans/review`, { data: { action: 'review', cycleId: 'cycle_demo_session_1_1', planId: 'demo_plan_1', decision: 'approved', feedback: '', expected: { submissionId: submitted.plan.latestSubmission.id, cycleId: submitted.session.cycle.id, status: submitted.plan.reviewStatus, feedback: submitted.plan.teacherFeedback ?? '' } } })).status(), 200);
      await teacher.close();
    }
    const session = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const tab = await session.newPage();
    await tab.route("**/api/notices", route => route.fulfill({json:{feed:{notices:[],unreadCount:0,unreadImportantCount:0,popupNotice:null}}}));
    tab.on('dialog', (dialog) => dialog.accept());
    const errors = [];
    tab.on('pageerror', (error) => errors.push(error.message));
    assert.equal((await session.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234', academicYear: 2026 } })).status(), 200);
    const endpoint = `/api/inquiry/${kind}`;
    const id = kind === 'plan' ? 'demo_plan_1' : 'report_demo_session_1';
    const first = kind === 'plan' ? 'topic' : 'purpose';
    const second = kind === 'plan' ? 'motivation' : 'terms';
    await tab.goto(`${base}/inquiry#${kind}`);
    const a = tab.locator(`#${kind}-${first}`);
    const b = tab.locator(`#${kind}-${second}`);
    const saveButton = tab.getByRole('button', { name: '임시 저장', exact: true });
    const readSaved = async () => (await (await session.request.get(`${base}/api/inquiry?team=demo_team_1`)).json()).data[kind].formData[first];
    const waitSaved = async (expected) => {
      for (let n = 0; n < 80; n++) {
        if (await readSaved() === expected) return;
        await tab.waitForTimeout(100);
      }
      assert.equal(await readSaved(), expected);
    };
    await a.waitFor();
    const baseline = await readSaved();
    let automaticWrites = 0;
    tab.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(endpoint)) automaticWrites++; });
    await a.fill('Unsaved typing across fields and background');
    await b.focus();
    await tab.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tab.waitForTimeout(700);
    await tab.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(automaticWrites, 0, 'blur and background must not save to server');
    assert.equal(await readSaved(), baseline);
    await tab.reload(); await a.waitFor();
    assert.equal(await a.inputValue(), 'Unsaved typing across fields and background');
    await tab.getByRole('button', { name: '선생님께 제출', exact: true }).click();
    await tab.getByText('작성한 내용을 먼저 임시 저장한 뒤 제출해 주세요.', { exact: true }).waitFor();
    assert.equal(automaticWrites, 0, 'submission must not implicitly save pending input');
    console.log(`PASS: ${kind} local recovery without automatic server save or submission`);
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    let held = false;
    await tab.route(`**${endpoint}`, async (route) => {
      if (!held && route.request().method() === 'PATCH') { held = true; await gate; }
      await route.continue();
    });
    await a.fill(`First version ${Date.now()}`);
    const sending = tab.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(endpoint));
    await saveButton.click(); await sending;
    await a.fill('Newer typing while saving');
    const saved = tab.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(endpoint));
    finish(); await saved; await tab.waitForTimeout(1000);
    assert.equal(await a.inputValue(), 'Newer typing while saving');
    await saveButton.click(); await waitSaved('Newer typing while saving');
    console.log(`PASS: ${kind} typing during save`);
    await tab.unroute(`**${endpoint}`);

    let offline = true;
    await tab.route(`**${endpoint}`, async (route) => {
      if (offline && route.request().method() === 'PATCH') await route.abort('internetdisconnected');
      else await route.continue();
    });
    await a.fill('Offline draft must survive'); await b.focus(); await saveButton.click();
    await tab.getByText('저장하지 못한 내용이 있습니다.', { exact: true }).waitFor();
    await tab.getByRole('button', { name: '💬 이론 탐구', exact: true }).click();
    await tab.getByRole('button', { name: kind === 'plan' ? '📝 탐구 계획' : '보고서', exact: true }).click();
    assert.equal(await a.inputValue(), 'Offline draft must survive');
    await tab.reload(); await a.waitFor();
    assert.equal(await a.inputValue(), 'Offline draft must survive');
    offline = false;
    await saveButton.click(); await waitSaved('Offline draft must survive');
    console.log(`PASS: ${kind} offline, internal tabs, reload and retry`);

    await a.fill('Before external reference');
    const outside = await session.newPage();
    await outside.route('https://example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic external reference</h1>' }));
    await outside.goto('https://example.test/reference'); await outside.bringToFront();
    // Simulate expiry while the renewal timer is suspended, using only our local lock.
    await session.request.post(`${base}${endpoint}/lock`, { data: { [`${kind}Id`]: id, fieldKey: first, action: 'release' } });
    await tab.bringToFront();
    await tab.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    assert.equal(await a.inputValue(), 'Before external reference');
    await a.fill('Before external reference and after returning');
    await saveButton.click(); await waitSaved('Before external reference and after returning');
    await outside.close();
    console.log(`PASS: ${kind} external tab return and lock renewal`);

    offline = true;
    await a.fill('Unsaved draft across external navigation');
    await tab.route('https://example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic external reference</h1>' }));
    await tab.goto('https://example.test/same-tab');
    await tab.goBack(); await a.waitFor();
    assert.equal(await a.inputValue(), 'Unsaved draft across external navigation');
    offline = false;
    await saveButton.click(); await waitSaved('Unsaved draft across external navigation');
    console.log(`PASS: ${kind} external navigation and browser back preserves draft`);

    await a.fill('My local draft');
    // Another device of the same synthetic account; no lock bypass on real data.
    const remote = await session.request.patch(`${base}${endpoint}`, { data: kind === 'plan'
      ? { cycleId: 'cycle_demo_session_1_1', planId: id, fieldKey: first, value: 'Saved on another device' }
      : { kind: 'field', cycleId: 'cycle_demo_session_1_1', reportId: id, fieldKey: first, value: 'Saved on another device' } });
    assert.equal(remote.status(), 200);
    await b.focus();
    await tab.getByRole('region', { name: '작성 내용 비교' }).waitFor();
    assert.equal(await a.inputValue(), 'My local draft');
    assert.equal(await readSaved(), 'Saved on another device');
    await tab.getByRole('button', { name: '비교 완료 · 내 내용 사용', exact: true }).click();
    assert.equal(await readSaved(), 'Saved on another device', 'conflict choice does not implicitly save');
    await saveButton.click();
    await waitSaved('My local draft');
    console.log(`PASS: ${kind} conflicting remote edit preserves both versions`);
    assert.deepEqual(errors, [], 'no unhandled browser errors');
    assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no tablet page overflow');
    await session.close();
  }
} finally {
  await browser.close();
}
