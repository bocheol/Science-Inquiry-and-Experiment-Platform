import { expect, it, vi } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { recordPlanRevision, recordReportRevision, restorePlanRevision, restoreReportRevision } from "@/lib/document-history";
import { lockPlanField, releasePlanField, savePlanField, submitPlan, selectTopic } from "@/lib/plan-service";
import { lockReportField, releaseReportField, saveReportField, saveReportMemberRole, submitReport } from "@/lib/report-service";
import { PATCH as patchPlan } from "@/app/api/inquiry/plan/route";
import { PATCH as patchReport } from "@/app/api/inquiry/report/route";

vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => ({ id: "demo_student_1", role: "student", mustChangePassword: false }) }));
let sequence = 200;
async function fixture() {
  const db = await getDb(); const id = `cycle_boundary_${++sequence}`;
  await db.query("INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, 'class_2026_9', $2, '합성 경계팀', 'demo_student_1')", [id, sequence]);
  await db.query("INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $1, 'demo_student_1')", [id]);
  await db.query("INSERT INTO inquiry_sessions (id, team_id, stage) VALUES ($1, $1, 'REPORTING')", [id]);
  const cycleId = await ensureInitialCycle(db, id);
  await db.query("INSERT INTO investigation_plans (id, session_id, cycle_id) VALUES ($1, $1, $2)", [id, cycleId]);
  await db.query("INSERT INTO reports (id, session_id, cycle_id) VALUES ($1, $1, $2)", [id, cycleId]);
  return { db, id, cycleId };
}

it("blocks teacher and leader restoration of completed documents without changing records", async () => {
  const f = await fixture();
  await recordPlanRevision(f.db, f.id, "demo_student_1", "before_completion");
  await recordReportRevision(f.db, f.id, "demo_student_1", "before_completion");
  await f.db.query("UPDATE inquiry_cycles SET status = 'completed' WHERE id = $1", [f.cycleId]);
  const revisions = (await f.db.query<{id: string; document_type: string}>("SELECT id, document_type FROM document_revisions WHERE document_id = $1", [f.id])).rows;
  const before = (await f.db.query("SELECT * FROM document_revisions WHERE document_id = $1", [f.id])).rows;
  const beforePlan = (await f.db.query("SELECT * FROM investigation_plans WHERE id = $1", [f.id])).rows;
  const beforeReport = (await f.db.query("SELECT * FROM reports WHERE id = $1", [f.id])).rows;
  for (const actor of ["teacher_bootstrap", "demo_student_1"]) for (const revision of revisions) {
    const restore = revision.document_type === "plan" ? restorePlanRevision : restoreReportRevision;
    await expect(restore(f.id, revision.id, actor, f.cycleId)).rejects.toThrow("완료된");
  }
  expect((await f.db.query("SELECT * FROM document_revisions WHERE document_id = $1", [f.id])).rows).toEqual(before);
  expect((await f.db.query("SELECT * FROM investigation_plans WHERE id = $1", [f.id])).rows).toEqual(beforePlan);
  expect((await f.db.query("SELECT * FROM reports WHERE id = $1", [f.id])).rows).toEqual(beforeReport);
});

it("rejects old-cycle writes, submits and lock changes even when document IDs and empty values match", async () => {
  const f = await fixture(); const next = f.cycleId + "_next";
  await f.db.query("UPDATE inquiry_cycles SET status = 'completed' WHERE id = $1", [f.cycleId]);
  await f.db.query("INSERT INTO inquiry_cycles (id, session_id, ordinal, title, status, origin) VALUES ($1, $2, 2, '다음 회차', 'active', 'configured')", [next, f.id]);
  await f.db.query("UPDATE investigation_plans SET cycle_id = $1 WHERE id = $2", [next, f.id]);
  await f.db.query("UPDATE reports SET cycle_id = $1 WHERE id = $2", [next, f.id]);
  const actor = { id: "demo_student_1", name: "합성 학생" };
  await expect(selectTopic(f.id, f.id, "이전 회차 주제", actor.id, "", f.cycleId)).rejects.toThrow("회차가 변경");
  for (const save of [savePlanField, saveReportField]) await expect(save(f.id, "purpose", "이전 글", actor.id, "", f.cycleId)).rejects.toThrow("회차가 변경");
  await expect(saveReportMemberRole(f.id, actor.id, "이전 역할", actor.id, "", f.cycleId)).rejects.toThrow("회차가 변경");
  for (const submit of [submitPlan, submitReport]) await expect(submit(f.id, actor.id, f.cycleId)).rejects.toThrow("회차가 변경");
  for (const [lock, release] of [[lockPlanField, releasePlanField], [lockReportField, releaseReportField]] as const) {
    await lock(f.id, "purpose", actor, next);
    await expect(lock(f.id, "purpose", actor, f.cycleId)).rejects.toThrow("회차가 변경");
    await expect(release(f.id, "purpose", actor.id, f.cycleId)).rejects.toThrow("회차가 변경");
    await release(f.id, "purpose", actor.id, next);
  }
  for (const [kind, patch] of [["plan", patchPlan], ["report", patchReport]] as const) {
    const body = { [`${kind}Id`]: f.id, kind: "field", fieldKey: "purpose", value: "현재 글", expectedValue: "" };
    const send = (input: object) => patch(new Request("http://localhost/api/inquiry/" + kind, { method: "PATCH", body: JSON.stringify(input) }));
    expect((await send(body)).status).toBe(400);
    expect((await send({ ...body, cycleId: f.cycleId })).status).toBe(409);
    expect((await send({ ...body, cycleId: next })).status).toBe(200);
  }
});
