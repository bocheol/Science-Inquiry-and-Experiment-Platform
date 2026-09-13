import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { getInquiryDataForTeam } from "@/lib/inquiry-data";

it("keeps older unresolved requests visible without mixing teams, cycles, or practice-only submissions", async () => {
  const db = await getDb();
  const before = await getInquiryDataForTeam("demo_team_1");
  const cycle = before!.session.cycle!.id;
  await db.query("UPDATE users SET account_type='demo' WHERE id='demo_student_1'");
  await db.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title,status,origin) VALUES('pending-view-old-cycle','demo_session_1',2,'합성 이전 회차','completed','configured')");
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES('pending-other-team','class_2026_9',99,'합성 다른 팀')");
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES('pending-other-session','pending-other-team')");
  await db.query("INSERT INTO inquiry_cycles(id,session_id,ordinal,title) VALUES('pending-other-cycle','pending-other-session',1,'합성 다른 회차')");
  async function add(id: string, status: string, offset: number, options: { practice?: boolean; snapshot?: boolean; old?: boolean; other?: boolean } = {}) {
    await db.query(`INSERT INTO material_requests(id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data,sync_status,sync_snapshot,submitted_at)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, options.other ? "pending-other-session" : before!.session.id,
      options.other ? "pending-other-cycle" : options.old ? "pending-view-old-cycle" : cycle,
      options.other ? "pending-other-team" : "demo_team_1", options.practice ? "demo_student_1" : "demo_student_2",
      JSON.stringify([{ name: id, specification: "原文", quantity: 1, unitPrice: 100, shipping: 0, link: "" }]),
      status, options.snapshot ? JSON.stringify({ spreadsheetId: "synthetic-only" }) : null, new Date(Date.UTC(2026, 8, 9, 0, offset))]);
  }
  await add("pending-oldest", "pending", 1);
  await add("failed-second", "failed", 2, { snapshot: true });
  await add("practice-excluded", "pending", 3, { practice: true });
  await add("uncertain-demo-included", "failed", 4, { practice: true, snapshot: true });
  await add("old-cycle-excluded", "pending", 5, { old: true });
  await add("other-team-excluded", "pending", 6, { other: true });
  await add("latest-synced", "synced", 7);
  const original = (await db.query("SELECT * FROM material_requests ORDER BY id")).rows;
  const view = await getInquiryDataForTeam("demo_team_1");
  expect(view!.materials?.id).toBe("latest-synced");
  expect(view!.pendingMaterials?.map(item => item.id)).toEqual(["pending-oldest", "failed-second", "uncertain-demo-included"]);
  expect(view!.pendingMaterials?.[0]).toMatchObject({ syncStatus: "pending", submittedAt: "2026-09-09T00:01:00.000Z", items: [{ name: "pending-oldest", specification: "原文" }] });
  expect((await db.query("SELECT * FROM material_requests ORDER BY id")).rows).toEqual(original);
});
