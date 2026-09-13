import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { lockPlanField, releasePlanField, savePlanField } from "@/lib/plan-service";
import { lockReportField, releaseReportField, saveReportField, saveReportMemberRole } from "@/lib/report-service";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";

beforeAll(async () => { await getDb(); });

describe("document saving after background tab suspension", () => {
  it("saves the first field in an empty plan", async () => {
    const db = await getDb();
    await db.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ('empty_draft_team', 'class_2026_1', 80, 'Local draft test')");
    await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('empty_draft_session', 'empty_draft_team')");
    const cycleId = await ensureInitialCycle(db, "empty_draft_session", "teacher_bootstrap");
    await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id) VALUES ('empty_draft_plan', 'empty_draft_session', $1)", [cycleId]);
    await expect(savePlanField("empty_draft_plan", "topic", "first topic", "demo_student_1", "")).resolves.toBeUndefined();
  });
  it("preserves simultaneous plan saves to different fields", async () => {
    await Promise.all([
      savePlanField("demo_plan_1", "purpose", "purpose from A", "demo_student_1"),
      savePlanField("demo_plan_1", "method", "method from B", "demo_student_2"),
    ]);
    const db = await getDb();
    const row = (await db.query("SELECT form_data FROM investigation_plans WHERE id = 'demo_plan_1'")).rows[0];
    expect(row.form_data).toMatchObject({ purpose: "purpose from A", method: "method from B" });
  });
  it("rejects a stale plan draft, and accepts retry after a lost success response", async () => {
    await savePlanField("demo_plan_1", "motivation", "new teammate text", "demo_student_2", "");
    await expect(savePlanField("demo_plan_1", "motivation", "stale tab text", "demo_student_1", "")).rejects.toThrow("다른 곳에서");
    await expect(savePlanField("demo_plan_1", "motivation", "new teammate text", "demo_student_2", "")).resolves.toBeUndefined();
  });
  it("rejects stale report fields and member roles", async () => {
    const id = "report_demo_session_1";
    await saveReportField(id, "purpose", "new report text", "demo_student_2", "");
    await expect(saveReportField(id, "purpose", "stale report text", "demo_student_1", "")).rejects.toThrow("다른 곳에서");
    await saveReportMemberRole(id, "demo_student_1", "new role", "demo_student_2", "");
    await expect(saveReportMemberRole(id, "demo_student_1", "stale role", "demo_student_1", "")).rejects.toThrow("다른 곳에서");
  });
  it("rejects one of two simultaneous report saves based on the same original", async () => {
    const results = await Promise.allSettled([
      saveReportField("report_demo_session_1", "terms", "device A", "demo_student_1", ""),
      saveReportField("report_demo_session_1", "terms", "device B", "demo_student_1", ""),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("can clear an inherited report title and subsequently edit the explicit empty title", async () => {
    const db = await getDb();
    await db.query("UPDATE inquiry_sessions SET selected_topic = 'inherited title' WHERE id = 'demo_session_1'");
    await saveReportField("report_demo_session_1", "title", "", "demo_student_1", "inherited title");
    await expect(saveReportField("report_demo_session_1", "title", "new title", "demo_student_1", "")).resolves.toBeUndefined();
  });
  it("allows only one winner when two members acquire the same expired field", async () => {
    for (const [id, acquire, release] of [
      ["demo_plan_1", lockPlanField, releasePlanField],
      ["report_demo_session_1", lockReportField, releaseReportField],
    ] as const) {
      const results = await Promise.allSettled([
        acquire(id, "purpose", { id: "demo_student_1", name: "Local A" }),
        acquire(id, "purpose", { id: "demo_student_2", name: "Local B" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await release(id, "purpose", "demo_student_1");
      await release(id, "purpose", "demo_student_2");
    }
  });
});
