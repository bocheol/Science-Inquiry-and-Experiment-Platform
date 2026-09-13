import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { requestCycleAnalysis } from "@/lib/cycle-analysis";
import { transitionCycle } from "@/lib/cycle-workflow";

it.each((["start_next", "finish_project"] as const).flatMap(action => ["shared", "assigned", "master", "student"].map(role => ({ action, role }))))(
  "$action and cached analysis retain the existing $role club management scope", async ({ action, role }) => {
    const db = await getDb(), key = `cycle-scope-${action}-${role}`, actor = `${key}-actor`, team = `${key}-team`, session = `${key}-session`, club = `${key}-club`;
    await db.query("UPDATE users SET is_master=TRUE WHERE id='teacher_bootstrap'");
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES($1,'합성 회차 교사',$1,2026,$2,'unused',FALSE,$3)", [actor, role === "student" ? "student" : "teacher", role === "master"]);
    await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,2026,'합성 권한 동아리','teacher_bootstrap')", [club]);
    await db.query("INSERT INTO teams(id,club_id,team_number,name) VALUES($1,$2,1,'합성 권한팀')", [team, club]);
    await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$2)", [session, team]);
    const cycle = await ensureInitialCycle(db, session, "teacher_bootstrap");
    if (role === "assigned") await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,$2,'teacher_bootstrap')", [club, actor]);
    await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data,review_status) VALUES($1,$2,$3,$4,'approved')", [`${key}-plan`, session, cycle, JSON.stringify({ topic: "합성 원문" })]);
    await db.query("INSERT INTO reports(id,session_id,cycle_id,form_data,status) VALUES($1,$2,$3,$4,'reviewed')", [`${key}-report`, session, cycle, JSON.stringify({ title: "합성 원문" })]);
    await requestCycleAnalysis(cycle, action === "start_next" ? "intermediate" : "final", "teacher_bootstrap", async () => ({ model: "synthetic", result: { overview: "합성 검증", inquiryField: "과학", researchType: "측정", strengths: [], findings: [], cycleComparison: [], limitations: [], suggestions: [{ title: "측정 기록", rationale: "자료 비교", evidenceIds: ["plan:topic"], feasibleNextStep: "측정 간격 비교", safetyNote: "", questionForStudents: "어떤 조건인가요?" }] } }));
    const before = (await db.query("SELECT * FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0];
    const evidence = (await db.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows;
    const cached = requestCycleAnalysis(cycle, action === "start_next" ? "intermediate" : "final", actor, async () => { throw new Error("Existing analysis must be reused"); });
    if (role === "assigned" || role === "master") await expect(cached).resolves.toBeDefined();
    else await expect(cached).rejects.toThrow("권한");
    const call = transitionCycle({ cycleId: cycle, action, teacherId: actor });
    if (role === "assigned" || role === "master") {
      await call;
      expect((await db.query("SELECT status FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0].status).toBe("completed");
    } else {
      await expect(call).rejects.toThrow("권한");
      expect((await db.query("SELECT * FROM inquiry_cycles WHERE id=$1", [cycle])).rows[0]).toEqual(before);
    }
    expect((await db.query("SELECT * FROM cycle_evidence_snapshots WHERE cycle_id=$1 ORDER BY id", [cycle])).rows).toEqual(evidence);
  },
);
