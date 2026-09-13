// Built local app, synthetic accounts/DB, all AI writes intercepted in the browser.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import pg from "pg";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const { database, base } = JSON.parse(await readFile(new URL("local-browser-target.json", root), "utf8"));
assert.equal(base, "http://127.0.0.1:3108"); assert.match(database, /^codex_validation_browser_[0-9]+_[a-f0-9]+$/);
const db = new pg.Pool({ host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), database, ssl: false });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  async function login(loginId) {
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { loginId, password: "student1234" } })).status(), 200);
    await context.addCookies((await context.cookies()).map(cookie => ({ ...cookie, secure: false })));
  }
  await login("10901");
  const { data } = await (await context.request.get(`${base}/api/inquiry`)).json();
  const session = data.session.id, cycle = data.session.cycle.id;
  const key = `inquiry-ai-chat:demo_student_1:${session}:${cycle}`;
  await db.query("UPDATE inquiry_sessions SET ai_topic_suggestions=$1 WHERE id=$2", [JSON.stringify({ directions: [{ title: "합성 방향", reason: "합성 이유", relation: "합성 연결", candidateQuestion: "합성 연구 질문", variables: [], feasibility: "합성", safetyNote: "합성" }] }), session]);
  const page = await context.newPage(), errors = [], requests = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  let mode = "abort", held, arrived, finished, release;
  await page.route("**/api/inquiry/{messages,topic-suggestions,topic-select}", async route => {
    requests.push({ path: new URL(route.request().url()).pathname, ...route.request().postDataJSON() });
    if (mode === "abort") return route.abort("failed");
    if (mode === "malformed") return route.fulfill({ status: 200, contentType: "text/plain", body: "incomplete-response" });
    if (mode === "hold") {
      const wait = held, done = finished; arrived(); await wait;
      try { await route.fulfill({ status: 200, json: { ok: true } }); } catch { /* Expected after leaving the page or tab. */ }
      done(); return;
    }
    return route.fulfill({ status: 200, json: { ok: true } });
  });
  function hold() {
    mode = "hold";
    held = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { arrived = resolve; }), done = new Promise(resolve => { finished = resolve; });
    return { ready, done, release: () => release() };
  }
  const message = page.locator(".chat-composer input"), interest = page.locator(".chat-side textarea");
  const send = () => page.getByRole("button", { name: "보내기", exact: true }).click();
  const directions = () => page.getByRole("button", { name: "AI와 방향 3개 찾기", exact: true }).click();
  const open = async () => { await page.goto(`${base}/inquiry`); await message.waitFor(); await page.waitForFunction(() => !document.querySelector(".chat-composer input")?.disabled); };
  const saved = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
  await open(); await message.fill("연결이 끊겨도 남을 합성 질문"); await interest.fill("복구할 합성 관심사");
  await send(); await page.locator(".chat-main").getByRole("alert").filter({ hasText: "연결을 확인" }).waitFor();
  assert.equal(await message.inputValue(), "연결이 끊겨도 남을 합성 질문"); assert.equal(await message.isEnabled(), true);
  const firstId = requests.at(-1).requestId; assert.equal((await saved()).messageRequest.id, firstId);
  await open(); assert.equal(await message.inputValue(), "연결이 끊겨도 남을 합성 질문"); assert.equal(await interest.inputValue(), "복구할 합성 관심사");
  mode = "malformed"; await send(); await page.locator(".chat-main").getByRole("alert").filter({ hasText: "서버 응답" }).waitFor();
  assert.equal(requests.at(-1).requestId, firstId); assert.equal(await message.isEnabled(), true);
  await page.getByRole("button", { name: /대화.*기록/ }).first().click();
  await page.getByRole("button", { name: /이론 탐구/ }).first().click();
  await message.waitFor(); assert.equal(await message.inputValue(), "연결이 끊겨도 남을 합성 질문");
  mode = "success"; await send(); await page.waitForFunction(() => document.querySelector(".chat-composer input")?.value === "");
  assert.equal(requests.at(-1).requestId, firstId); assert.equal((await saved()).messageRequest, null);
  results.push("network failure and malformed responses release input and preserve question/request ID across reload and tab changes; acknowledgement clears it once");

  mode = "abort"; await directions(); await page.locator(".chat-main").getByRole("alert").filter({ hasText: "연결을 확인" }).waitFor();
  const topicId = requests.at(-1).requestId;
  await open(); const topic = hold(); await directions(); await topic.ready;
  assert.equal(requests.at(-1).requestId, topicId);
  await interest.fill("응답 대기 중 추가한 합성 관심사"); topic.release(); await topic.done;
  await page.waitForFunction(() => !document.querySelector(".chat-composer input")?.disabled);
  assert.equal(await interest.inputValue(), "응답 대기 중 추가한 합성 관심사");
  assert.equal((await saved()).interest, "응답 대기 중 추가한 합성 관심사");
  mode = "abort"; await page.getByRole("button", { name: "이 방향 선택", exact: true }).click();
  await page.locator(".chat-main").getByRole("alert").filter({ hasText: "연결을 확인" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "이 방향 선택", exact: true }).isEnabled(), true);
  results.push("topic retries reuse their ID; edits during generation survive its reply; failed direction selection unlocks controls");

  await message.fill("탭 이동 전 합성 질문"); const old = hold(); await send(); await old.ready;
  await page.getByRole("button", { name: /대화.*기록/ }).first().click();
  await page.getByRole("button", { name: /이론 탐구/ }).first().click();
  await message.waitFor(); await message.fill("새 화면에서 추가한 합성 질문");
  old.release(); await old.done;
  assert.equal(await message.inputValue(), "새 화면에서 추가한 합성 질문"); assert.equal((await saved()).message, "새 화면에서 추가한 합성 질문");
  results.push("leaving an in-flight chat aborts the browser wait; an old reply cannot clear a remounted draft");

  const nextCycle = "synthetic_ai_draft_cycle_2";
  const oldCycleRequest = hold(); await send(); await oldCycleRequest.ready;
  const fixture = await db.connect();
  try {
    await fixture.query("BEGIN");
    await fixture.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1", [cycle]);
    await fixture.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title) VALUES($1,$2,2,'합성 다음 회차')", [nextCycle, session]);
    await fixture.query("UPDATE investigation_plans SET cycle_id=$1,form_data='{}',review_status='draft' WHERE session_id=$2", [nextCycle, session]);
    await fixture.query("UPDATE reports SET cycle_id=$1,form_data='{}',status='draft' WHERE session_id=$2", [nextCycle, session]);
    await fixture.query("UPDATE inquiry_sessions SET interest_input=NULL,ai_topic_suggestions='{}',stage='STARTING' WHERE id=$1", [session]);
    await fixture.query("COMMIT");
  } catch (error) { await fixture.query("ROLLBACK"); throw error; } finally { fixture.release(); }
  await open(); assert.equal(await message.inputValue(), ""); assert.equal(await interest.inputValue(), "");
  await message.fill("두 번째 회차의 합성 질문"); oldCycleRequest.release(); await oldCycleRequest.done;
  assert.equal(await message.inputValue(), "두 번째 회차의 합성 질문"); assert.equal((await saved()).message, "새 화면에서 추가한 합성 질문");
  mode = "abort"; await send(); await page.locator(".chat-main").getByRole("alert").filter({ hasText: "연결을 확인" }).waitFor();
  assert.equal(requests.at(-1).cycleId, nextCycle);
  results.push("cycle rollover keeps the former draft/request untouched and uses a separate new-cycle draft");

  await login("10902"); await open();
  assert.equal(await message.inputValue(), "");
  assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).message, `inquiry-ai-chat:demo_student_1:${session}:${nextCycle}`), "두 번째 회차의 합성 질문");
  results.push("another signed-in student does not inherit the former student's draft in the same tab");
  await page.addInitScript(() => {
    const nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("inquiry-ai-chat:")) throw new Error("Synthetic unavailable storage"); return nativeSet.call(this, key, value); };
  });
  await open(); await message.fill("보관 불가 시 화면에 유지할 합성 질문");
  await page.getByText("이 브라우저에서는 초안을 보관하지 못합니다.", { exact: false }).waitFor();
  assert.equal(await message.inputValue(), "보관 불가 시 화면에 유지할 합성 질문");
  results.push("unavailable storage keeps the in-memory draft and displays a concrete copy-before-leaving notice");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: fileURLToPath(new URL("ai-chat-draft-browser.png", root)), fullPage: true });
  await writeFile(new URL("ai-chat-draft-browser.json", root), JSON.stringify({ results, browserErrors: errors.length, interceptedRequests: requests.length }, null, 2));
  console.log(`${results.length} AI draft browser scenarios passed`);
} finally { await browser.close(); await db.end(); }
