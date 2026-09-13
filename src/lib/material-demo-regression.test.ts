import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sync: vi.fn().mockResolvedValue({ rowCount: 1 }) }));
vi.mock("@/lib/material-sheet-transfer", () => ({ executeMaterialSheetTransfer: mocks.sync, prepareMaterialSheetTransfer: mocks.sync }));
import { getDb } from "@/lib/db";
import { retryMaterialSync, saveAndSyncMaterials } from "@/lib/materials";
import { getInquiryDataForTeam } from "@/lib/inquiry-data";

it("keeps a demo student's material request out of Sheets even when retried by a teacher", async () => {
  const db = await getDb();
  await db.query("UPDATE users SET account_type = 'demo' WHERE id = 'demo_student_1'");
  const input = { submissionId: "demo-retry-test", sessionId: "demo_session_1", teamId: "demo_team_1", actorId: "demo_student_1", items: [{ name: "연습 품목", specification: "", unitPrice: 100, quantity: 1, shipping: 0, link: "https://example.test/item" }] };
  await db.query("INSERT INTO material_requests (id, submission_id, session_id, team_id, submitted_by, form_data, total_amount, budget_status) VALUES ('demo-material-request', $1, $2, $3, $4, $5, 60000, 'over_budget')", [input.submissionId, input.sessionId, input.teamId, input.actorId, JSON.stringify(input.items)]);
  const row = (await db.query("SELECT id FROM material_requests WHERE submission_id = $1", [input.submissionId])).rows[0];
  expect(await retryMaterialSync(row.id, "teacher_bootstrap")).toMatchObject({ syncStatus: "pending", total: 60000, budgetStatus: "over_budget" });
  expect(mocks.sync).not.toHaveBeenCalled();
  expect((await db.query("SELECT submitted_by FROM material_requests WHERE id = $1", [row.id])).rows[0].submitted_by).toBe("demo_student_1");
});

it("exposes practice status without falsely recording a successful Sheet transfer", async () => {
  const db = await getDb();
  await db.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
  await saveAndSyncMaterials({ submissionId: "practice-visible", sessionId: "demo_session_1", teamId: "demo_team_1", actorId: "demo_student_1", items: [{ name: "합성 연습", specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "" }] });
  expect((await getInquiryDataForTeam("demo_team_1"))?.materials).toMatchObject({ isPractice: true, syncStatus: "pending" });
  expect((await db.query("SELECT sync_snapshot,synced_at FROM material_requests WHERE submission_id='practice-visible'")).rows[0]).toEqual({ sync_snapshot: null, synced_at: null });
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("does not let a demo actor convert or overwrite a standard student's request", async () => {
  const db = await getDb();
  await db.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
  const cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id='demo_session_1' AND status='active'")).rows[0].id;
  const items = [{ name: "일반 신청 원문", specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "" }];
  await db.query("INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data) VALUES('standard-original','standard-original','demo_session_1',$1,'demo_team_1','demo_student_2',$2)", [cycle, JSON.stringify(items)]);
  const original = (await db.query("SELECT * FROM material_requests WHERE id='standard-original'")).rows[0];
  await expect(saveAndSyncMaterials({ submissionId: "standard-original", sessionId: "demo_session_1", cycleId: cycle, teamId: "demo_team_1", actorId: "demo_student_1", items: [{ ...items[0], name: "체험으로 덮어쓰기" }] })).rejects.toThrow("일반 학생");
  expect((await db.query("SELECT * FROM material_requests WHERE id='standard-original'")).rows[0]).toEqual(original);
  expect(mocks.sync).not.toHaveBeenCalled();
});
