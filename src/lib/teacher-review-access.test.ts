import { expect, it, vi } from "vitest";
vi.mock("@/lib/push-notifications", () => ({ sendPushForNotice: vi.fn() }));
import { getDb } from "@/lib/db";
import { reviewPlan } from "@/lib/plan-service";
import { reviewReport } from "@/lib/report-service";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";

it.each(["plan", "report"].flatMap(document => ["shared", "assigned", "master", "student"].map(role => ({ document, role }))))(
  "$document review preserves the existing $role scope and document history", async ({ document, role }) => {
    const db = await getDb(), key = `review-scope-${document}-${role}`, actor = `${key}-actor`, team = `${key}-team`, session = `${key}-session`, club = `${key}-club`;
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 검토자',$1,2026,$2,'unused',FALSE,$3)", [actor, role === "student" ? "student" : "teacher", role === "master"]);
    await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 권한 동아리','teacher_bootstrap')", [club]);
    await db.query("INSERT INTO teams(id,club_id,team_number,name) VALUES($1,$2,1,'합성 권한팀')", [team, club]);
    await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$2)", [session, team]);
    const cycle = await ensureInitialCycle(db, session, "teacher_bootstrap");
    if (role === "assigned") await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')", [club, actor]);
    const table = document === "plan" ? "investigation_plans" : "reports";
    if (document === "plan") await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'pending')", [key, session, cycle, JSON.stringify({ topic: "합성 원문" })]);
    else await db.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'submitted')", [key, session, cycle, JSON.stringify({ title: "합성 원문" })]);
    const before = (await db.query(`SELECT * FROM ${table} WHERE id=$1`, [key])).rows[0];
    const call = document === "plan" ? reviewPlan(key, actor, "approved", "", "", { cycleId: cycle, submissionId: null, status: "pending", feedback: "" })
      : reviewReport(key, actor, "reviewed", "", { cycleId: cycle, version: 0, status: "submitted", feedback: "" });
    const allowed = role !== "student" && (document === "report" || role !== "shared");
    if (allowed) {
      await call;
      expect((await db.query(`SELECT reviewed_by,form_data FROM ${table} WHERE id=$1`, [key])).rows[0]).toEqual({ reviewed_by: actor, form_data: before.form_data });
    } else {
      await expect(call).rejects.toThrow("권한");
      expect((await db.query(`SELECT * FROM ${table} WHERE id=$1`, [key])).rows[0]).toEqual(before);
    }
    expect((await db.query("SELECT id FROM document_revisions WHERE document_id=$1", [key])).rows).toHaveLength(allowed ? 1 : 0);
  },
);
