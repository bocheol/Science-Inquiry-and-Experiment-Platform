// Runs only against the local server; journal requests use synthetic responses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:3107';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  const errors = [];
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234' } })).status(), 200);
  await page.route('**/api/inquiry?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.plan.reviewStatus = 'approved';
    body.data.materials = { id: 'synthetic-material', items: [], totalAmount: 0, budgetStatus: 'within_budget', syncStatus: 'pending', syncError: null };
    await route.fulfill({ response, json: body });
  });
  let finish;
  let failGet = false;
  let failPost = false;
  let saved = null;
  let posts = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/inquiry/journals*', async route => {
    if (route.request().method() === 'GET') {
      if (failGet) return route.abort('failed');
      return route.fulfill({ json: { journals: saved ? [saved] : [] } });
    }
    posts++;
    if (failPost) return route.abort('failed');
    const form = await new Response(route.request().postDataBuffer(), { headers: { 'content-type': route.request().headers()['content-type'] } }).formData();
    const expectedVersion = form.get('expectedVersion') === 'null' ? null : Number(form.get('expectedVersion'));
    if ((saved?.version ?? null) !== expectedVersion) return route.fulfill({ status: 409, json: { message: '다른 기기의 저장과 충돌했습니다.' } });
    saved = { id: 'synthetic-journal', sessionId: 'demo_session_1', studentId: 'demo_student_1', sessionNumber: Number(form.get('sessionNumber')), date: form.get('date'), activities: form.get('activities'), observations: form.get('observations'), reflections: form.get('reflections'), images: [], version: (saved?.version ?? 0) + 1, createdAt: saved?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (posts === 1) await gate;
    return route.fulfill({ json: { journal: saved } });
  });
  const open = async () => { await page.getByRole('button', { name: '실험 일지', exact: true }).click({ timeout: 15000 }); await page.locator('#journal-activities').waitFor(); await page.waitForTimeout(300); };
  await page.goto(`${base}/inquiry`);
  await open();
  const activities = page.locator('#journal-activities');
  await activities.fill('먼저 저장한 관찰');
  await page.locator('#journal-observations').fill('측정값 1');
  await page.locator('#journal-reflections').focus();
  await page.waitForTimeout(600);
  assert.equal(posts, 0, 'typing and blur must not save the journal to server');
  const sending = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/inquiry/journals'));
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await sending;
  await activities.fill('저장 중 새로 작성한 관찰');
  finish();
  await page.getByRole('button', { name: '임시 저장', exact: true }).waitFor();
  assert.equal(await activities.inputValue(), '저장 중 새로 작성한 관찰');
  console.log('PASS: journal preserves text entered during save');
  await page.waitForTimeout(700);
  failGet = true;
  await page.reload();
  await open();
  assert.equal(await activities.inputValue(), '저장 중 새로 작성한 관찰');
  console.log('PASS: journal restores local draft when server loading fails');
  failGet = false;
  failPost = true;
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await page.locator('.journal-editor [role="alert"]').filter({ hasText: /fetch|연결|저장/i }).waitFor();
  await activities.fill('연결 끊김 후 추가 관찰');
  failPost = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(700);
  assert.equal(posts, 2, 'reconnection must not implicitly save new typing');
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await page.getByText('1차시 일지를 저장했습니다.', { exact: true }).waitFor();
  assert.equal(saved.activities, '연결 끊김 후 추가 관찰');
  assert.equal(await page.locator('.journal-editor [role="alert"]').count(), 0, 'successful retry clears the previous error');
  console.log('PASS: journal reconnect keeps local text until explicit manual save');
  await activities.fill('내 기기의 충돌 초안');
  await page.waitForTimeout(600);
  saved = { ...saved, activities: '다른 기기에서 저장한 내용', version: saved.version + 1, updatedAt: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  assert.equal(await activities.inputValue(), '내 기기의 충돌 초안');
  const beforeResolve = posts;
  await page.getByRole('button', { name: '내 작성 내용으로 계속', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(posts, beforeResolve, 'choosing a conflict version must not save implicitly');
  await page.getByRole('button', { name: '임시 저장', exact: true }).click();
  await page.getByText('1차시 일지를 저장했습니다.', { exact: true }).waitFor();
  assert.equal(saved.activities, '내 기기의 충돌 초안');
  console.log('PASS: journal compares another-device update and writes only after explicit save');
  await page.evaluate(async ({ key, serverVersion }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('science-inquiry-journal-drafts', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put({
        key, sessionId: 'demo_session_1', sessionNumber: 1, date: '2026-09-07', activities: '저장 번호가 없던 예전 기기 초안',
        observations: '예전 관찰', reflections: '', existingImages: [], newPhotos: [], pendingSync: false,
        savedAt: new Date().toISOString(), legacyServerVersionOnlyForTest: serverVersion,
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { key: 'demo_session_1:demo_student_1', serverVersion: saved.version });
  await page.reload();
  await open();
  await page.getByText('최신 저장 내용과 내 초안을 비교해 주세요.', { exact: true }).waitFor();
  assert.equal(await activities.inputValue(), '저장 번호가 없던 예전 기기 초안');
  const beforeLegacyResolve = posts;
  await page.getByRole('button', { name: '최신 저장 내용 사용', exact: true }).click();
  assert.equal(await activities.inputValue(), '내 기기의 충돌 초안');
  assert.equal(posts, beforeLegacyResolve, 'resolving a legacy draft must not write to server');
  console.log('PASS: legacy journal draft requires comparison and remains recoverable');
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
