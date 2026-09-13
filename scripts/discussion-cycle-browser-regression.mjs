// A local built app, synthetic browser DB, and intercepted discussion writes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
  const login = await context.request.post(`${base}/api/auth/login`, { data: { loginId: "10901", password: "student1234" } });
  assert.equal(login.status(), 200);
  // The production build sets Secure cookies; this loopback-only test adopts
  // that synthetic cookie for HTTP without changing the product cookie policy.
  const cookies = await context.cookies();
  await context.addCookies(cookies.map(cookie => ({ ...cookie, secure: false })));
  const initial = await context.request.get(`${base}/api/inquiry`); assert.equal(initial.status(), 200);
  const { data } = await initial.json(); assert.equal(data.team.id, "demo_team_1");
  const cycle = data.session.cycle.id, session = data.session.id;
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const seedReadOnlyRecord = async (recordCycle, label) => {
    const id = `browser_entry_${recordCycle}`;
    await db.query("INSERT INTO discussion_entries(id,session_id,cycle_id,author_id,kind,activity_date,content) VALUES($1,$2,$3,'demo_student_1','peer',$4,$5)", [id, session, recordCycle, date, label]);
    const source = { id, sessionId: session, authorId: "demo_student_1", authorName: "합성 학생", kind: "peer", activityDate: date, content: label, participants: [], confirmedBy: [], parentId: null, createdAt: new Date().toISOString() };
    await db.query("INSERT INTO cycle_discussion_days(session_id,cycle_id,activity_date,generated_version,status) VALUES($1,$2,$3,1,'ready')", [session, recordCycle, date]);
    await db.query("INSERT INTO cycle_discussion_summaries(id,session_id,cycle_id,activity_date,version,content,sources) VALUES($1,$2,$3,$4,1,$5,$6)", [`browser_summary_${recordCycle}`, session, recordCycle, date, JSON.stringify([{ category: "discussion", text: `${label} 정리`, sourceIds: [id] }]), JSON.stringify([source])]);
  };
  await seedReadOnlyRecord(cycle, "첫 회차 보존 원문");
  await db.query("INSERT INTO discussion_summaries(id,session_id,activity_date,version,content,sources) VALUES('browser_legacy_summary',$1,$2,1,$3,'[]')", [session, date, JSON.stringify([{ category: "discussion", text: "예전 형식 보존 정리", sourceIds: [] }])]);
  const legacyKey = `inquiry-discussion:demo_student_1:${session}`, firstKey = `${legacyKey}:${cycle}`, secondCycle = "synthetic_browser_cycle_two", secondKey = `${legacyKey}:${secondCycle}`;
  const page = await context.newPage(), errors = [], sent = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/discussions", async route => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { message: "합성 저장 실패 · 작성 내용을 유지해 주세요." } });
  });
  await page.addInitScript(({ legacyKey, firstKey, secondKey }) => {
    if (sessionStorage.getItem("synthetic-discussion-seeded")) return;
    sessionStorage.setItem("synthetic-discussion-seeded", "yes");
    sessionStorage.setItem(legacyKey, JSON.stringify({ text: "이전 형식 초안" }));
    sessionStorage.setItem(firstKey, JSON.stringify({ text: "첫 회차 초안" }));
    sessionStorage.setItem(secondKey, JSON.stringify({ text: "둘째 회차 초안" }));
  }, { legacyKey, firstKey, secondKey });
  const open = async () => {
    await page.goto(`${base}/inquiry`);
    await page.getByRole("button", { name: /대화.*기록|활동 기록/ }).first().click();
    await page.getByRole("heading", { name: "팀 대화·활동 기록" }).waitFor();
  };
  await open();
  const text = page.getByPlaceholder("실험 아이디어와 의견을 나눠 보세요.");
  await text.waitFor(); assert.equal(await text.inputValue(), "첫 회차 초안");
  await page.getByText("회차를 확인할 수 없는 이전 초안", { exact: true }).click();
  assert.ok(await page.getByText("이전 형식 초안", { exact: true }).isVisible());
  await text.fill("첫 회차 편집 내용");
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.getByText("합성 저장 실패 · 작성 내용을 유지해 주세요.").waitFor();
  assert.equal(sent[0].cycleId, cycle); assert.equal(await text.inputValue(), "첫 회차 편집 내용");
  await open(); assert.equal(await text.inputValue(), "첫 회차 편집 내용");
  const fixture = await db.connect();
  await fixture.query("BEGIN");
  try {
    await fixture.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1", [cycle]);
    await fixture.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status,origin,created_by) VALUES($1,$2,2,'합성 둘째 회차','active','configured','teacher_bootstrap')", [secondCycle, session]);
    await fixture.query("UPDATE investigation_plans SET cycle_id=$1,form_data='{}',review_status='draft' WHERE session_id=$2", [secondCycle, session]);
    await fixture.query("UPDATE reports SET cycle_id=$1,form_data='{}',status='draft' WHERE session_id=$2", [secondCycle, session]);
    await fixture.query("UPDATE inquiry_sessions SET stage='STARTING',selected_topic=NULL WHERE id=$1", [session]);
    await fixture.query("COMMIT");
  } catch (error) { await fixture.query("ROLLBACK"); throw error; }
  finally { fixture.release(); }
  await seedReadOnlyRecord(secondCycle, "둘째 회차 보존 원문");
  await open(); assert.equal(await text.inputValue(), "둘째 회차 초안");
  const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).text, firstKey);
  assert.equal(stored, "첫 회차 편집 내용");
  await page.getByText("둘째 회차 보존 원문", { exact: true }).waitFor();
  assert.equal(await page.getByText("첫 회차 보존 원문", { exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "기록을 볼 탐구 회차" }).selectOption(cycle);
  await page.getByText("첫 회차 보존 원문", { exact: true }).waitFor();
  assert.equal(await text.count(), 0);
  assert.equal(await page.getByText("둘째 회차 보존 원문", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "날짜별 AI 정리", exact: true }).click();
  await page.getByText("첫 회차 보존 원문 정리", { exact: true }).waitFor();
  await page.getByText("이전 형식의 날짜별 정리 보기", { exact: true }).click();
  await page.getByText(`${date} · 이력 1`, { exact: true }).click();
  await page.getByText("예전 형식 보존 정리", { exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("discussion-scoped-browser.png", root)), fullPage: true });
  await page.getByRole("combobox", { name: "기록을 볼 탐구 회차" }).selectOption(secondCycle);
  await page.getByText("둘째 회차 보존 원문 정리", { exact: true }).waitFor();
  await page.getByRole("button", { name: "우리끼리 대화", exact: true }).click();
  await text.waitFor(); assert.equal(await text.inputValue(), "둘째 회차 초안");
  await db.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1", [secondCycle]);
  await db.query("UPDATE inquiry_sessions SET stage='COMPLETED' WHERE id=$1", [session]);
  await open();
  assert.equal(await text.count(), 0);
  assert.equal(await page.getByRole("button", { name: "이 날짜 지금 정리" }).count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(new URL("discussion-scoped-browser.json", root), JSON.stringify({ firstCycleDraftRecovered: true, legacyDraftReadOnly: true, failurePreservesText: true, requestCycleMatches: true, secondCycleDraftIsolated: true, completedStudentReadOnly: true, sameDayCycleSourceIsolation: true, previousCycleSummaryReadOnly: true, legacySummaryPreservedSeparately: true, browserErrors: 0 }, null, 2));
  console.log("Discussion cycle drafts, failure recovery, request cycle and completed read-only UI: passed");
} finally { await browser.close(); await db.end(); }
