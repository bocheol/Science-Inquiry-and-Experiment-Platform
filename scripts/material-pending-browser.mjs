// Built local app, disposable PostgreSQL, synthetic records and intercepted Sheets responses only.
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
  const cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id='demo_session_1' AND status='active'")).rows[0].id;
  for (const [id, status, index] of [["old_pending", "pending", 1], ["old_unknown", "failed", 2], ["latest_synced", "synced", 3]]) {
    const items = [{ name: `합성 ${id}`, specification: "500mL 원래 규격", quantity: 1, unitPrice: 100, shipping: 0, link: "https://example.test/original-item" }];
    await db.query(`INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,total_amount,sync_status,submitted_at)
      VALUES($1,$1,'demo_session_1',$2,'demo_team_1','demo_student_2',$3,100,$4,$5)`, [id, cycle, JSON.stringify(items), status, new Date(Date.UTC(2026, 8, 9, 0, index))]);
  }
  const original = (await db.query("SELECT * FROM material_requests ORDER BY id")).rows;
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { loginId: "teacher", password: "synthetic-browser-only" } })).status(), 200);
  await context.addCookies((await context.cookies()).map(cookie => ({ ...cookie, secure: false })));
  const page = await context.newPage(), errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/teacher/team/demo_team_1`);
  const card = page.getByRole("article", { name: "준비물 신청 검토" });
  await card.getByRole("heading", { name: "이전 미전송 신청 2건" }).waitFor();
  await card.getByRole("region", { name: "최근 준비물 신청" }).getByText("시트 반영", { exact: true }).waitFor();
  const old = card.locator("details").filter({ has: page.getByText(/미전송 신청 1 · 합성 old_pending/) });
  await old.locator("summary").click();
  await old.getByText("https://example.test/original-item", { exact: true }).waitFor();
  assert.match(await old.innerText(), /500mL 원래 규격/);
  const button = old.getByRole("button", { name: "Google Sheet 재전송", exact: true });
  let mode = "network";
  await page.route("**/api/teacher/materials/retry", async route => {
    const body = route.request().postDataJSON(); requests.push(body.requestId);
    if (mode === "network") return route.abort("failed");
    if (mode === "invalid") return route.fulfill({ status: 200, contentType: "application/json", body: "invalid-json" });
    if (mode === "failure") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, syncStatus: "failed", syncError: "합성 전송 실패: 원문 보존" }) });
    assert.equal(mode, "success"); assert.equal(body.requestId, "old_pending");
    // Simulate only this response's committed state in the identified disposable DB.
    await db.query("UPDATE material_requests SET sync_status='synced' WHERE id='old_pending'");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, syncStatus: "synced" }) });
  });
  for (const attempt of ["network", "invalid", "failure"]) {
    mode = attempt; await button.click();
    await card.getByRole("alert").waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('article[aria-label="준비물 신청 검토"] button')].every(node => !node.disabled));
    assert.equal(await button.isEnabled(), true);
    assert.match(await card.getByRole("alert").innerText(), attempt === "failure" ? /합성 전송 실패/ : /신청은 보존/);
  }
  assert.deepEqual((await db.query("SELECT * FROM material_requests ORDER BY id")).rows, original);
  await card.screenshot({ path: fileURLToPath(new URL("material-pending-browser.png", root)) });
  mode = "success"; await button.click();
  await card.getByRole("heading", { name: "이전 미전송 신청 1건" }).waitFor();
  assert.deepEqual(requests, ["old_pending", "old_pending", "old_pending", "old_pending"]);
  assert.equal(await card.getByText(/미전송 신청 .*합성 old_pending/).count(), 0);
  await card.getByRole("region", { name: "최근 준비물 신청" }).getByText("시트 반영", { exact: true }).waitFor();
  // Actual API refuses unknown legacy targets before any external transport call.
  const unknown = await context.request.post(`${base}/api/teacher/materials/retry`, { data: { requestId: "old_unknown" } });
  assert.equal(unknown.status(), 400); assert.match((await unknown.json()).message, /대조/);
  for (const row of original) {
    const actual = (await db.query("SELECT * FROM material_requests WHERE id=$1", [row.id])).rows[0];
    assert.deepEqual(actual, row.id === "old_pending" ? { ...row, sync_status: "synced" } : row);
  }
  await db.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1", [cycle]);
  await page.reload();
  await card.getByRole("heading", { name: "이전 미전송 신청 1건" }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Google Sheet 재전송", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(new URL("material-pending-browser.json", root), JSON.stringify({ latestSyncedAndOlderPendingVisible: true, originalItemsVisible: true, networkAndJsonAndTransferFailureRecover: true, exactRequestIds: requests, refreshedPendingCount: 1, unknownLegacyTargetBlockedByRealApi: true, completedCycleReadOnly: true, browserErrors: 0, externalSheetCalls: 0 }, null, 2));
  console.log("Older pending requests, retry recovery, target selection and read-only browser checks passed");
} finally { await browser.close(); await db.end(); }
