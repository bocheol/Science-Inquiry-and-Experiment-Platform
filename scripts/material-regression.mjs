// Local synthetic accounts only; every material submission is intercepted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:3107';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const login = await context.request.post(`${base}/api/auth/login`, { data: { loginId: '10901', password: 'student1234' } });
  assert.equal(login.status(), 200);
  let fail = false;
  let hold = false;
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const sent = [];
  await page.route('**/api/inquiry/materials', async route => {
    sent.push(route.request().postDataJSON());
    if (fail) return route.abort('internetdisconnected');
    if (hold) await gate;
    return route.fulfill({ json: { ok: true, syncStatus: 'synced', syncError: null } });
  });
  const open = async () => { await page.getByRole('button', { name: '🧪 준비물 신청', exact: true }).click(); await page.getByPlaceholder('품명', { exact: true }).waitFor(); };
  await page.goto(`${base}/inquiry`);
  await open();
  const name = page.getByPlaceholder('품명', { exact: true });
  const submit = page.getByRole('button', { name: '준비물 제출', exact: true });
  await name.fill('작성 중인 준비물');
  await page.getByRole('button', { name: '💬 이론 탐구', exact: true }).click();
  await open();
  assert.equal(await name.inputValue(), '작성 중인 준비물');
  await page.reload(); await open();
  assert.equal(await name.inputValue(), '작성 중인 준비물');
  assert.equal(sent.length, 0);
  console.log('PASS: material draft survives internal navigation and reload without submission');

  fail = true;
  await submit.click();
  await page.getByRole('main').getByText('연결이 끊겼거나 응답이 늦습니다. 작성 내용은 유지되며 준비물 제출을 다시 시도할 수 있습니다.', { exact: true }).waitFor();
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await name.inputValue(), '작성 중인 준비물');
  const firstId = sent[0].submissionId;
  await page.reload(); await open();
  fail = false;
  hold = true;
  const sending = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/inquiry/materials'));
  await submit.click(); await sending;
  assert.equal(sent[1].submissionId, firstId, 'retry after reload must retain request identity');
  console.log('PASS: network failure unlocks submission and retains draft and request identity');

  await name.fill('저장 중 추가 수정');
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/inquiry/materials'));
  finish(); await response;
  await submit.waitFor();
  assert.equal(await name.inputValue(), '저장 중 추가 수정');
  assert.equal(sent[1].items[0].name, '작성 중인 준비물');
  await submit.click();
  await page.waitForTimeout(500);
  assert.equal(sent[2].items[0].name, '저장 중 추가 수정');
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log('PASS: saved response preserves edits made while submitting');
} finally { await browser.close(); }
