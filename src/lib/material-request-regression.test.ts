import { beforeAll, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sync: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/material-sheet-transfer", () => ({ executeMaterialSheetTransfer: mocks.sync, prepareMaterialSheetTransfer: mocks.prepare }));
import { getDb } from "@/lib/db";
import { retryMaterialSync, saveAndSyncMaterials } from "@/lib/materials";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";

const items = [{ name: "Synthetic material", specification: "", unitPrice: 100, quantity: 1, shipping: 0, link: "https://example.test/item" }];
const input = (submissionId: string) => ({ submissionId, sessionId: "demo_session_1", teamId: "demo_team_1", actorId: "demo_student_1", items });
let clubCycleId: string;

beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO clubs (id, academic_year, name, created_by) VALUES ('material-club', 2026, 'Synthetic club', 'teacher_bootstrap')");
  await db.query("INSERT INTO teams (id, club_id, team_number, name, leader_user_id) VALUES ('material-club-team', 'material-club', 1, 'Synthetic team', 'demo_student_1')");
  await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('material-club-session', 'material-club-team')");
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES('material-club-member','material-club-team','demo_student_1')");
  clubCycleId = await ensureInitialCycle(db, "material-club-session", "teacher_bootstrap");
  for (const [version, status, sheet] of [[1, "archived", "original-sheet"], [2, "published", "new-sheet"]] as const) {
    await db.query(`INSERT INTO club_config_versions (id, club_id, config_type, version_number, title, status, definition, created_by)
      VALUES ($1, 'material-club', 'materials', $2, 'Synthetic config', $3, $4, 'teacher_bootstrap')`,
    [`material-config-${version}`, version, status, JSON.stringify({ sheet: { spreadsheetId: sheet, sheetName: "Materials", layout: "header_row", columnMapping: { name: "A" } } })]);
  }
});
beforeEach(async () => {
  await (await getDb()).query("DELETE FROM material_sheet_dispatch");
  await (await getDb()).query("DELETE FROM material_requests WHERE session_id = 'material-club-session' AND sync_snapshot IS NULL");
  mocks.sync.mockReset().mockResolvedValue({ rowCount: 1 });
  mocks.prepare.mockReset().mockImplementation(async (snapshot, operationId) => ({ requests: [{ synthetic: snapshot }], receiptId: operationId, sheetName: snapshot.sheetName, rowCount: snapshot.items.length }));
});

async function oldRequest(id: string, config: string | null = "material-config-1") {
  const db = await getDb();
  await db.query(`INSERT INTO material_requests
    (id, submission_id, session_id, cycle_id, team_id, submitted_by, form_data, total_amount, budget_status, sync_status, config_version_id, submitted_at)
    VALUES ($1, $1, 'material-club-session', $2, 'material-club-team', 'demo_student_1', $3, 60000, 'approved', 'failed', $4, '2026-09-01T00:00:00Z')`, [id, clubCycleId, JSON.stringify(items), config]);
  return (await db.query("SELECT * FROM material_requests WHERE id = $1", [id])).rows[0];
}

it("rejects an old screen's cycle before saving or sending to Sheets", async () => {
  await expect(saveAndSyncMaterials({ ...input("material-old-cycle-screen"), cycleId: "previous-cycle" })).rejects.toThrow("회차");
  expect((await (await getDb()).query("SELECT id FROM material_requests WHERE submission_id='material-old-cycle-screen'")).rows).toHaveLength(0);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("rejects another team's submission ID without altering it or sending to Sheets", async () => {
  const before = await oldRequest("material-owner-test");
  await expect(saveAndSyncMaterials(input(before.submission_id))).rejects.toThrow("권한");
  const db = await getDb();
  expect((await db.query("SELECT * FROM material_requests WHERE id = $1", [before.id])).rows[0]).toEqual(before);
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("rejects mismatched team and session IDs before saving", async () => {
  await expect(saveAndSyncMaterials({ ...input("material-context-test"), sessionId: "material-club-session" })).rejects.toThrow("팀 정보");
  const db = await getDb();
  expect((await db.query("SELECT id FROM material_requests WHERE submission_id = 'material-context-test'")).rows).toHaveLength(0);
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("retries an immutable snapshot after team/leader/config changes and preserves metadata", async () => {
  const db = await getDb();
  mocks.sync.mockRejectedValueOnce(new Error("Synthetic lost response"));
  const requestInput = { ...input("material-pinned-test"), teamId: "material-club-team", sessionId: "material-club-session" };
  await saveAndSyncMaterials(requestInput);
  const before = (await db.query("SELECT * FROM material_requests WHERE submission_id = $1", [requestInput.submissionId])).rows[0];
  expect(before.sync_error).toBe("Google Sheets 전송에 실패했습니다. 담당 교사가 연결 상태를 확인해 주세요.");
  expect(before.sync_error).not.toContain("Synthetic lost response");
  await db.query("UPDATE material_requests SET budget_status = 'approved', total_amount = 60000 WHERE id = $1", [before.id]);
  await db.query("UPDATE teams SET name = 'Renamed team', leader_user_id = 'demo_student_2' WHERE id = 'material-club-team'");
  await db.query("UPDATE club_config_versions SET status = 'archived' WHERE id = 'material-config-2'");
  expect(await retryMaterialSync(before.id, "teacher_bootstrap")).toMatchObject({ total: 60000, budgetStatus: "approved", syncStatus: "synced" });
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.sync.mock.calls[1]).toEqual(mocks.sync.mock.calls[0]);
  const after = (await db.query("SELECT * FROM material_requests WHERE id = $1", [before.id])).rows[0];
  expect(after).toMatchObject({ submitted_by: before.submitted_by, submitted_at: before.submitted_at, config_version_id: before.config_version_id, total_amount: 60000, budget_status: "approved", sync_snapshot: before.sync_snapshot });
  await retryMaterialSync(before.id, "teacher_bootstrap");
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  await db.query("UPDATE teams SET name = 'Synthetic team', leader_user_id = 'demo_student_1' WHERE id = 'material-club-team'");
  await db.query("UPDATE club_config_versions SET status = 'published' WHERE id = 'material-config-2'");
});

it("does not guess a current configuration for a legacy submission without one", async () => {
  const before = await oldRequest("material-missing-config-test", null);
  await expect(retryMaterialSync(before.id, "teacher_bootstrap")).rejects.toThrow("제출 당시");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("new club submissions pin the current published version", async () => {
  await saveAndSyncMaterials({ ...input("material-new-club-test"), teamId: "material-club-team", sessionId: "material-club-session" });
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ spreadsheetId: "new-sheet" }), expect.any(String));
  const db = await getDb();
  expect((await db.query("SELECT config_version_id FROM material_requests WHERE submission_id = 'material-new-club-test'")).rows[0].config_version_id).toBe("material-config-2");
});

it("does not append under a new submission ID when a legacy header-row request has no known location", async () => {
  await oldRequest("material-legacy-append");
  await expect(saveAndSyncMaterials({ ...input("material-legacy-new-id"), teamId: "material-club-team", sessionId: "material-club-session" })).rejects.toThrow("기존 신청의 시트 위치");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("does not resend an identical successfully synced submission", async () => {
  await saveAndSyncMaterials(input("material-identical-test"));
  // PostgreSQL jsonb may return object keys in a different order.
  const reordered = [{ link: items[0].link, shipping: 0, quantity: 1, unitPrice: 100, specification: "", name: items[0].name }];
  await saveAndSyncMaterials({ ...input("material-identical-test"), items: reordered });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("blocks changed payloads during an unresolved send and preserves the first snapshot", async () => {
  let finish!: (value: { rowCount: number }) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  mocks.sync.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const first = saveAndSyncMaterials(input("material-inflight-test"));
  await Promise.race([began, first.then(() => { throw new Error("Expected the first Sheet send to wait"); })]);
  const newerItems = [{ ...items[0], name: "Updated material" }];
  await expect(saveAndSyncMaterials({ ...input("material-inflight-test"), items: newerItems })).rejects.toThrow("이전 전송");
  finish({ rowCount: 1 });
  expect(await first).toMatchObject({ syncStatus: "synced" });
  const db = await getDb();
  expect((await db.query("SELECT form_data, sync_status FROM material_requests WHERE submission_id = 'material-inflight-test'")).rows[0]).toEqual({ form_data: items, sync_status: "synced" });
  await saveAndSyncMaterials({ ...input("material-inflight-test"), items: newerItems });
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
});

it("keeps a spreadsheet reservation after an uncertain write and releases only after retry succeeds", async () => {
  const db = await getDb();
  mocks.sync.mockRejectedValueOnce(new Error("Synthetic uncertain write"));
  expect(await saveAndSyncMaterials(input("material-reservation"))).toMatchObject({ syncStatus: "failed" });
  expect((await db.query("SELECT * FROM material_sheet_dispatch")).rows).toHaveLength(1);
  await expect(saveAndSyncMaterials(input("material-other-reservation"))).rejects.toThrow("이전 전송");
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await saveAndSyncMaterials(input("material-reservation"));
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect((await db.query("SELECT * FROM material_sheet_dispatch")).rows).toHaveLength(0);
});

it("a late duplicate failure cannot demote a successful retry", async () => {
  const db = await getDb();
  let fail!: (error: Error) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  mocks.sync.mockImplementationOnce(() => { started(); return new Promise((_, reject) => { fail = reject; }); });
  const first = saveAndSyncMaterials(input("material-late-failure"));
  await began;
  expect(await saveAndSyncMaterials(input("material-late-failure"))).toMatchObject({ syncStatus: "synced" });
  fail(new Error("Late synthetic failure"));
  expect(await first).toMatchObject({ syncStatus: "synced" });
  expect((await db.query("SELECT sync_status FROM material_requests WHERE submission_id = 'material-late-failure'")).rows[0].sync_status).toBe("synced");
});

it("a stale retry cannot overwrite a newer submission", async () => {
  await saveAndSyncMaterials(input("material-stale-retry"));
  mocks.sync.mockClear();
  await expect(saveAndSyncMaterials({ ...input("material-stale-retry"), items: [{ ...items[0], name: "Stale material" }] }, true)).rejects.toThrow("신청 내용이 변경");
  expect(mocks.sync).not.toHaveBeenCalled();
});

it.each(["success", "failure"])("rejects an obsolete %s response after a newer send has started", async outcome => {
  const db = await getDb(), submissionId = `material-obsolete-${outcome}`;
  let finishOld!: () => void, finishNew!: () => void, startedOld!: () => void, startedNew!: () => void;
  const oldReady = new Promise<void>(resolve => { startedOld = resolve; }), newReady = new Promise<void>(resolve => { startedNew = resolve; });
  mocks.sync.mockImplementationOnce(() => { startedOld(); return new Promise((resolve, reject) => { finishOld = () => outcome === "success" ? resolve({ rowCount: 1 }) : reject(new Error("Obsolete synthetic failure")); }); });
  const old = saveAndSyncMaterials(input(submissionId));
  await oldReady;
  // Another response confirms the old batch, allowing the student to edit it.
  await saveAndSyncMaterials(input(submissionId));
  mocks.sync.mockImplementationOnce(() => { startedNew(); return new Promise(resolve => { finishNew = () => resolve({ rowCount: 1 }); }); });
  const newer = saveAndSyncMaterials({ ...input(submissionId), items: [{ ...items[0], name: "New fixed request content" }] });
  await newReady;
  const current = (await db.query("SELECT * FROM material_requests WHERE submission_id=$1", [submissionId])).rows[0];
  const dispatch = (await db.query("SELECT * FROM material_sheet_dispatch")).rows;
  finishOld();
  await expect(old).rejects.toThrow("준비물 신청이 변경");
  expect((await db.query("SELECT * FROM material_requests WHERE submission_id=$1", [submissionId])).rows[0]).toEqual(current);
  expect((await db.query("SELECT * FROM material_sheet_dispatch")).rows).toEqual(dispatch);
  finishNew();
  expect(await newer).toMatchObject({ syncStatus: "synced" });
});
