import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { requestStudentPlanAiReview, requestTeacherPlanAiReview } from "@/lib/plan-ai-review";
import { createPlanSubmission } from "@/lib/plan-snapshots";

const cases = ["inactive", "password", "year", "membership", "archive", "completed", "assignment", "withdrawn"] as const;
for (const audience of ["student", "teacher"] as const) {
  it.each(cases.filter(change => audience === "student" ? !["assignment", "withdrawn"].includes(change) : change !== "membership"))(
    `${audience} denies late completion after %s and preserves the saved source`, async change => {
      const db = await getDb(), key = `late_${audience}_${change}`, actor = `${key}_actor`;
      await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 검토자',$1,$2,$3,'unused',FALSE,FALSE)", [actor, ACADEMIC_YEAR, audience]);
      await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 검토 동아리','teacher_bootstrap')", [key, ACADEMIC_YEAR]);
      await db.query("INSERT INTO teams(id,club_id,team_number,name,leader_user_id) VALUES($1,$1,1,'합성 검토 팀',$2)", [key, actor]);
      await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, actor]);
      if (audience === "teacher") await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')", [key, actor]);
      await db.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$1,'PLANNING')", [key]);
      const cycle = await ensureInitialCycle(db, key, "teacher_bootstrap");
      const source = { topic: "합성 주제", method: "측정 방법" };
      await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$1,$2,$3,'pending')", [key, cycle, JSON.stringify(source)]);
      if (audience === "teacher") await createPlanSubmission(db, key, actor);
      const request = audience === "student" ? requestStudentPlanAiReview : requestTeacherPlanAiReview;
      let generated = false;
      await expect(request(key, actor, async () => {
        generated = true;
        if (change === "inactive") await db.query("UPDATE users SET status='inactive' WHERE id=$1", [actor]);
        if (change === "password") await db.query("UPDATE users SET must_change_password=TRUE WHERE id=$1", [actor]);
        if (change === "year") await db.query("UPDATE users SET academic_year=$2 WHERE id=$1", [actor, ACADEMIC_YEAR - 1]);
        if (change === "membership") await db.query("UPDATE team_members SET status='inactive' WHERE id=$1", [key]);
        if (change === "archive") await db.query("UPDATE teams SET status='archived' WHERE id=$1", [key]);
        if (change === "completed") await db.query("UPDATE inquiry_cycles SET status='completed' WHERE id=$1", [cycle]);
        if (change === "assignment") await db.query("DELETE FROM club_teacher_assignments WHERE club_id=$1", [key]);
        if (change === "withdrawn") await db.query("UPDATE plan_submissions SET review_status='withdrawn' WHERE plan_id=$1", [key]);
        return { model: "synthetic-no-network", result: { readiness: "needs_revision", summary: "합성 응답", strengths: [], checks: [], limitations: [] } };
      })).rejects.toThrow();
      expect(generated).toBe(true);
      expect((await db.query("SELECT id FROM plan_ai_reviews WHERE requested_by=$1", [actor])).rows).toHaveLength(0);
      const saved = (await db.query("SELECT form_data FROM investigation_plans WHERE id=$1", [key])).rows[0].form_data;
      expect(typeof saved === "string" ? JSON.parse(saved) : saved).toEqual(source);
    },
  );
}
