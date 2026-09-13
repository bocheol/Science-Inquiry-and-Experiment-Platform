import { beforeAll, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/material-sheet-transfer", () => ({ prepareMaterialSheetTransfer: transport, executeMaterialSheetTransfer: transport }));
import { getDb } from "@/lib/db";
import { saveAndSyncMaterials, retryMaterialSync } from "@/lib/materials";
const items = [{ name: "합성 권한 원문", specification: "", quantity: 1, unitPrice: 100, shipping: 0, link: "" }];
let cycle: string;
beforeAll(async () => {
  const db = await getDb();
  cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id='demo_session_1' AND status='active'")).rows[0].id;
  await db.query("UPDATE users SET account_type='demo' WHERE id='demo_student_2'");
  for (const demo of [false, true]) {
    const id = demo ? "access-demo" : "access-standard";
    await db.query("INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,sync_status) VALUES($1,$1,'demo_session_1',$2,'demo_team_1',$3,$4,$5)", [id, cycle, demo ? "demo_student_2" : "demo_student_1", JSON.stringify(items), demo ? "pending" : "synced"]);
  }
});

it.each(["new", "cached", "teacher-standard", "teacher-demo"].flatMap(path => ["inactive", "password"].map(condition => ({ path, condition }))))(
  "rejects $condition accounts in $path without changing saved requests or calling Sheets", async ({ path, condition }) => {
    const db = await getDb(), actor = path.startsWith("teacher") ? "teacher_bootstrap" : "demo_student_1";
    const original = (await db.query("SELECT * FROM material_requests ORDER BY id")).rows;
    try {
      await db.query(condition === "inactive" ? "UPDATE users SET status='inactive' WHERE id=$1" : "UPDATE users SET must_change_password=TRUE WHERE id=$1", [actor]);
      const run = path.startsWith("teacher") ? retryMaterialSync(path === "teacher-demo" ? "access-demo" : "access-standard", actor)
        : saveAndSyncMaterials({ submissionId: path === "new" ? `access-new-${condition}` : "access-standard", sessionId: "demo_session_1", cycleId: cycle, teamId: "demo_team_1", actorId: actor, items });
      await expect(run).rejects.toThrow("권한");
      expect((await db.query("SELECT * FROM material_requests ORDER BY id")).rows).toEqual(original);
      expect(transport).not.toHaveBeenCalled();
    } finally { await db.query("UPDATE users SET status='active',must_change_password=FALSE WHERE id=$1", [actor]); }
  },
);
