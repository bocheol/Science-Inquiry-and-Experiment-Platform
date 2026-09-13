import { beforeEach, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { selectTopic } from "@/lib/plan-service";
import { lockPlanField, releasePlanField, savePlanField } from "@/lib/plan-service";

beforeEach(async () => {
  const db = await getDb();
  await db.query("DELETE FROM field_locks WHERE plan_id = 'demo_plan_1'");
  await db.query("DELETE FROM document_revisions WHERE document_id = 'demo_plan_1'");
  await db.query("UPDATE investigation_plans SET form_data = $1, review_status = 'approved' WHERE id = 'demo_plan_1'", [JSON.stringify({ topic: "Original topic", purpose: "Existing purpose" })]);
  await db.query("UPDATE inquiry_sessions SET selected_topic = 'Original topic', stage = 'EXPERIMENTING' WHERE id = 'demo_session_1'");
});

it("reselecting a topic requires reapproval and preserves the previous document", async () => {
  const db = await getDb();
  await selectTopic("demo_session_1", "demo_plan_1", "Revised topic", "demo_student_1");
  expect((await db.query("SELECT form_data, review_status FROM investigation_plans WHERE id = 'demo_plan_1'")).rows[0]).toMatchObject({ form_data: { topic: "Revised topic", purpose: "Existing purpose" }, review_status: "reapproval_required" });
  const revisions = (await db.query("SELECT snapshot FROM document_revisions WHERE document_id = 'demo_plan_1'")).rows;
  expect(revisions).toHaveLength(1);
  expect(revisions[0].snapshot).toMatchObject({ formData: { topic: "Original topic" }, reviewStatus: "approved" });
});

it("topic selection cannot reset an ongoing experiment back to exploration", async () => {
  await selectTopic("demo_session_1", "demo_plan_1", "Revised topic", "demo_student_1");
  const db = await getDb();
  expect((await db.query("SELECT selected_topic, stage FROM inquiry_sessions WHERE id = 'demo_session_1'")).rows[0]).toEqual({ selected_topic: "Revised topic", stage: "EXPERIMENTING" });
});

it("topic selection respects a teammate's active field lock", async () => {
  await lockPlanField("demo_plan_1", "topic", { id: "demo_student_2", name: "Synthetic teammate" });
  await expect(selectTopic("demo_session_1", "demo_plan_1", "Conflicting topic", "demo_student_1")).rejects.toThrow("작성 중");
  await releasePlanField("demo_plan_1", "topic", "demo_student_2");
});

it("topic selection and another field's save preserve both changes", async () => {
  await Promise.all([
    selectTopic("demo_session_1", "demo_plan_1", "Concurrent topic", "demo_student_1"),
    savePlanField("demo_plan_1", "purpose", "Concurrent purpose", "demo_student_2"),
  ]);
  const db = await getDb();
  expect((await db.query("SELECT form_data FROM investigation_plans WHERE id = 'demo_plan_1'")).rows[0].form_data).toMatchObject({ topic: "Concurrent topic", purpose: "Concurrent purpose" });
});

it("rejects a plan belonging to a different session", async () => {
  await expect(selectTopic("different-session", "demo_plan_1", "Unrelated topic", "demo_student_1")).rejects.toThrow("계획서");
});

it("selecting the saved topic again leaves approval and history unchanged", async () => {
  await selectTopic("demo_session_1", "demo_plan_1", "Original topic", "demo_student_1");
  const db = await getDb();
  expect((await db.query("SELECT review_status FROM investigation_plans WHERE id = 'demo_plan_1'")).rows[0].review_status).toBe("approved");
  expect((await db.query("SELECT id FROM document_revisions WHERE document_id = 'demo_plan_1'")).rows).toHaveLength(0);
});

it("rejects a topic choice from an outdated screen", async () => {
  await expect(selectTopic("demo_session_1", "demo_plan_1", "Stale choice", "demo_student_1", "Older topic")).rejects.toThrow("다른 곳에서");
});

it("advances only the initial stage when selecting the first topic", async () => {
  const db = await getDb();
  await db.query("UPDATE inquiry_sessions SET stage = 'STARTING' WHERE id = 'demo_session_1'");
  await selectTopic("demo_session_1", "demo_plan_1", "First selected topic", "demo_student_1");
  expect((await db.query("SELECT stage FROM inquiry_sessions WHERE id = 'demo_session_1'")).rows[0].stage).toBe("EXPLORING");
});
