// Disposable local PostgreSQL only; no operating database or Sheets writes.
import assert from "node:assert/strict";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";
const { app } = await createLocalTestDb("material_budget");
globalThis.fetch = async () => { throw new Error("External network forbidden"); };
globalThis.__syntheticSheetPrepare = async (snapshot, operationId) => ({ requests: [], receiptId: operationId, sheetName: snapshot.sheetName, rowCount: snapshot.items.length });
let transfers = 0;
globalThis.__syntheticSheetTransfer = async () => { transfers += 1; return { rowCount: 1 }; };
try {
  const { saveAndSyncMaterials, retryMaterialSync } = await import("../src/lib/materials.ts");
  const { getInquiryDataForTeam } = await import("../src/lib/inquiry-data.ts");
  await app.query("UPDATE users SET account_type='standard' WHERE id='demo_student_1'");
  const items = [{ name: "합성 고액 장비", specification: "", unitPrice: 3_000_000_000, quantity: 2, shipping: 20_000_000, link: "" }];
  const saved = await saveAndSyncMaterials({ submissionId: "synthetic-budget-unlimited", sessionId: "demo_session_1", teamId: "demo_team_1", actorId: "demo_student_1", items });
  assert.equal(saved.total, 6_020_000_000);
  assert.equal(saved.budgetStatus, "within_budget");
  assert.equal(saved.syncStatus, "synced");
  const row = (await app.query("SELECT id,total_amount,pg_typeof(total_amount)::text AS type FROM material_requests WHERE submission_id='synthetic-budget-unlimited'")).rows[0];
  assert.equal(row.type, "bigint");
  assert.equal(row.total_amount, "6020000000");
  assert.equal((await getInquiryDataForTeam("demo_team_1")).materials.totalAmount, 6_020_000_000);
  assert.equal((await retryMaterialSync(row.id, "teacher_bootstrap")).total, 6_020_000_000);
  assert.equal(transfers, 1);
  console.log(JSON.stringify({ status: "passed", exactTotal: saved.total, storage: row.type, transfers }));
} finally { await app.end(); }
