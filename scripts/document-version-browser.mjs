// Production build + disposable local data; never connects to the deployed service.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = new URL("../output/test-infra/", import.meta.url);
const target = JSON.parse(await readFile(new URL("local-browser-target.json", root), "utf8"));
assert.equal(target.base, "http://127.0.0.1:3108");
assert.match(target.database, /^codex_validation_browser_[0-9]+_[a-f0-9]+$/);
const db = new pg.Pool({ host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), database: target.database, ssl: false });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let passed = 0;
try {
  const cycle = (await db.query("SELECT cycle_id FROM investigation_plans WHERE id='demo_plan_1'")).rows[0].cycle_id;
  await db.query("INSERT INTO reports(id,session_id,cycle_id,form_data) VALUES('report_demo_session_1','demo_session_1',$1,$2) ON CONFLICT(id) DO NOTHING", [cycle, { purpose: "현재 저장 보고서" }]);
  await db.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status) VALUES('browser_past','demo_session_1',2,'합성 완료 회차','completed') ON CONFLICT(id) DO NOTHING");
  for (const kind of ["plan", "report"]) {
    const doc = kind === "plan" ? "demo_plan_1" : "report_demo_session_1";
    for (const n of [1, 2]) await db.query("INSERT INTO document_revisions(id,document_type,document_id,cycle_id,snapshot,action,changed_by,created_at) VALUES($1,$2,$3,$4,$5,'field:purpose','demo_student_1',$6) ON CONFLICT(id) DO NOTHING", [
      "browser_" + kind + "_" + n, kind, doc, cycle, { formData: { purpose: "합성 목적 " + n, method: n === 1 ? "관찰 👨‍👩‍👧‍👦" : "관찰 👩‍🔬", ...(n === 2 ? { addedOnly: "두 번째 문서에 추가된 합성 항목" } : {}) }, roles: [], reviewStatus: "draft", status: "draft" }, "2026-09-0" + n + "T00:00:00Z"
    ]);
    await db.query("INSERT INTO document_revisions(id,document_type,document_id,cycle_id,snapshot,action,changed_by) VALUES($1,$2,$3,'browser_past',$4,'cycle_completed','demo_student_1') ON CONFLICT(id) DO NOTHING", ["browser_final_" + kind, kind, doc, { formData: { purpose: "완료 회차 보존 목적" }, roles: [] }]);
  }
  for (const kind of ["plan", "report"]) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    assert.equal((await context.request.post(target.base + "/api/auth/login", { data: { loginId: "10901", password: "student1234" } })).status(), 200);
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    let writes = 0;
    page.on("request", r => { if (r.method() !== "GET" && ["/api/inquiry/plan", "/api/inquiry/report"].includes(new URL(r.url()).pathname)) writes++; });
    await page.goto(target.base + "/inquiry#" + kind);
    const input = page.locator("#" + kind + "-purpose");
    await input.fill("비교 중에도 남아야 하는 미저장 초안");
    await page.getByRole("button", { name: "두 버전 비교", exact: true }).last().click();
    const modal = page.getByRole("dialog");
    await modal.getByLabel("기준 A").selectOption("revision:browser_" + kind + "_1");
    await modal.getByLabel("비교 B").selectOption("revision:browser_" + kind + "_2");
    await modal.locator(".version-result").waitFor();
    await modal.locator(".version-document-row").first().waitFor();
    assert.equal(await modal.getByRole("button", { name: "전체 문서", exact: true }).getAttribute("aria-pressed"), "true");
    assert.ok((await modal.locator(".version-document-row").count()) > 1);
    assert.ok((await modal.locator(".version-empty").count()) > 0);
    assert.ok((await modal.locator(".version-document-row").evaluateAll(rows => rows.every(row => {
      const cells = [...row.children].map(cell => cell.getBoundingClientRect());
      return cells.length === 2 && cells[0].top === cells[1].top && cells[0].height === cells[1].height;
    }))));
    assert.ok(await modal.locator("ins").count() > 0);
    assert.ok(await modal.locator("del").count() > 0);
    assert.equal(await modal.getByRole("button", { name: "이 상태로 복원", exact: true }).count(), 0);
    assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await modal.locator(".version-result").scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL("document-version-mobile-" + kind + ".png", root)), fullPage: false });
    await modal.getByRole("button", { name: "A/B 맞바꾸기" }).click();
    await modal.locator(".version-result").waitFor();
    assert.equal(await modal.getByLabel("기준 A").inputValue(), "revision:browser_" + kind + "_2");
    await modal.getByLabel("비교 B").selectOption("current:");
    await modal.locator(".version-result").waitFor();
    if (kind === "plan") await db.query("UPDATE investigation_plans SET form_data=$1,updated_at=CURRENT_TIMESTAMP WHERE id='demo_plan_1'", [{ purpose: "새 서버 저장 목적" }]);
    else await db.query("UPDATE reports SET form_data=$1,write_version=write_version+1 WHERE id='report_demo_session_1'", [{ purpose: "새 서버 저장 목적" }]);
    await modal.getByLabel("비교 B").selectOption("revision:browser_" + kind + "_1");
    await modal.locator(".version-result").waitFor();
    await modal.getByLabel("비교 B").selectOption("current:");
    await modal.getByText("선택한 서버 저장본이 바뀌었습니다.", { exact: false }).waitFor();
    await modal.getByRole("button", { name: "현재 저장본 다시 불러오기", exact: true }).click();
    await modal.locator(".version-result").waitFor();
    assert.ok((await modal.locator(".version-result").innerText()).includes("새 서버 저장 목적"));
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await modal.evaluate(el => el.scrollWidth <= el.clientWidth));
      const comparisonPanel = modal.locator(".version-document-scroll");
      const size = await comparisonPanel.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      if (width === 320) assert.ok(size.scroll > size.client);
      else assert.ok(size.scroll <= size.client);
      assert.ok(await modal.locator(".version-document-row").evaluateAll(rows => rows.every(row => {
        const cells = [...row.children].map(cell => cell.getBoundingClientRect());
        return cells.length === 2 && cells[0].top === cells[1].top && cells[0].height === cells[1].height;
      })));
    }
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    assert.equal(await input.inputValue(), "비교 중에도 남아야 하는 미저장 초안");
    await page.getByRole("button", { name: "두 버전 비교", exact: true }).last().click();
    await page.getByRole("dialog").waitFor();
    await page.goBack();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(await input.inputValue(), "비교 중에도 남아야 하는 미저장 초안");
    await page.reload();
    await page.waitForFunction(kind => document.querySelector("#" + kind + "-purpose")?.value === "비교 중에도 남아야 하는 미저장 초안", kind);
    assert.equal(writes, 0); assert.deepEqual(errors, []);
    await page.getByText("합성 완료 회차", { exact: true }).click();
    const past = page.locator("details").filter({ has: page.getByText("합성 완료 회차", { exact: true }) }).last();
    await past.getByRole("button", { name: kind === "plan" ? "계획서 두 버전 비교" : "보고서 두 버전 비교", exact: true }).click();
    await page.getByRole("dialog").locator(".version-result").waitFor();
    assert.ok((await page.getByRole("dialog").innerText()).includes("합성 완료 회차"));
    await context.close(); passed++; console.log("PASS mobile " + kind + ": two past versions, styling, swap, Escape/back, draft recovery, zero document writes, completed-cycle entry");
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.equal((await context.request.post(target.base + "/api/auth/login", { data: { loginId: "teacher", password: "synthetic-browser-only" } })).status(), 200);
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.goto(target.base + "/teacher/team/demo_team_1");
  await page.getByRole("button", { name: "승인 상태 변경", exact: true }).click();
  await page.locator("#feedback").fill("미저장 교사 의견");
  await page.locator("#report-feedback").fill("미저장 보고서 의견");
  for (const index of [0, 1]) {
    await page.getByRole("button", { name: "두 버전 비교", exact: true }).nth(index).click();
    await page.getByRole("dialog").locator(".version-result").waitFor();
    assert.ok(await page.getByRole("dialog").evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }
  assert.equal(await page.locator("#feedback").inputValue(), "미저장 교사 의견");
  assert.equal(await page.locator("#report-feedback").inputValue(), "미저장 보고서 의견");
  await context.close(); passed++; console.log("PASS teacher: shared plan/report dialog");
  await writeFile(new URL("document-version-browser.json", root), JSON.stringify({ passed, syntheticOnly: true, checkedAt: new Date().toISOString() }, null, 2));
} finally { await browser.close(); await db.end(); }
