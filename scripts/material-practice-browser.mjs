// Local built app with a newly-created disposable database and known synthetic accounts.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const { database, base } = JSON.parse(await readFile(new URL("local-browser-target.json", root), "utf8"));
assert.equal(base, "http://127.0.0.1:3108"); assert.match(database, /^codex_validation_browser_[0-9]+_[a-f0-9]+$/);
const db = new pg.Pool({ host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), database, ssl: false });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await db.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  async function login(loginId, password) {
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { loginId, password } })).status(), 200);
    await context.addCookies((await context.cookies()).map(cookie => ({ ...cookie, secure: false })));
  }
  await login("10901", "student1234");
  const { data } = await (await context.request.get(`${base}/api/inquiry`)).json();
  assert.equal(data.team.id, "demo_team_1");
  const items = [{ name: "합성 연습 비커", specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "https://example.test/item" }];
  // The real API receives a demo submitter in the identified synthetic database.
  const submissionId = randomUUID();
  const submitted = await context.request.post(`${base}/api/inquiry/materials`, { data: { submissionId, sessionId: data.session.id, cycleId: data.session.cycle.id, items } });
  assert.equal(submitted.status(), 200); assert.equal((await submitted.json()).syncStatus, "pending");
  const saved = (await db.query("SELECT * FROM material_requests WHERE submission_id=$1", [submissionId])).rows[0];
  assert.equal(saved.sync_snapshot, null); assert.equal(saved.synced_at, null);
  assert.equal((await db.query("SELECT * FROM material_sheet_dispatch")).rows.length, 0);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/inquiry`);
  await page.getByRole("button", { name: /준비물 신청/ }).first().click();
  await page.getByText("연습 제출 · 시트 미전송", { exact: true }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("material-practice-student.png", root)), fullPage: true });
  await login("teacher", "synthetic-browser-only");
  await page.goto(`${base}/teacher/team/${data.team.id}`);
  await page.getByText("연습 제출 · 시트 미전송", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Google Sheet 재전송", exact: true }).count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL("material-practice-teacher.png", root)), fullPage: true });
  // Add a separate standard request; do not convert or mutate the practice record.
  await db.query("INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,total_amount) VALUES('synthetic_standard_ui','synthetic_standard_ui',$1,$2,$3,'demo_student_2',$4,100)", [data.session.id, data.session.cycle.id, data.team.id, JSON.stringify(items)]);
  await page.reload();
  await page.getByRole("button", { name: "Google Sheet 재전송", exact: true }).waitFor();
  assert.equal(await page.getByText("연습 제출 · 시트 미전송", { exact: true }).count(), 0);
  await page.getByText("전송 대기", { exact: true }).waitFor();
  assert.deepEqual((await db.query("SELECT * FROM material_requests WHERE id=$1", [saved.id])).rows[0], saved);
  assert.deepEqual(errors, []);
  await writeFile(new URL("material-practice-browser.json", root), JSON.stringify({ practiceSubmittedThroughRealApi: true, studentPracticeLabel: true, teacherPracticeLabel: true, practiceRetryHidden: true, standardRetryRetained: true, originalPracticeRequestPreserved: true, dispatchRows: 0, browserErrors: 0 }, null, 2));
  console.log("Practice material API and student/teacher UI passed");
} finally { await browser.close(); await db.end(); }
