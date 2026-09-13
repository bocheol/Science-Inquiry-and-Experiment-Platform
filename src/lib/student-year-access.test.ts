import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";
import { getStudentActivities } from "@/lib/clubs";
import { assertActiveTeamMember, getInquiryDataForTeam, getInquiryDataForUser } from "@/lib/inquiry-data";

const cases = ["class", "club"].flatMap(kind => [false, true].flatMap(oldAccount => [false, true].map(oldTeam => ({ kind, oldAccount, oldTeam }))));
it.each(cases.map((item, index) => ({ ...item, index })))(
  "$kind activity: oldAccount=$oldAccount oldTeam=$oldTeam keeps the student within the current year", async ({ kind, oldAccount, oldTeam, index }) => {
    const db = await getDb(), key = `student_year_${index}`, actor = `${key}_actor`, team = `${key}_team`, activity = `${key}_activity`;
    const accountYear = ACADEMIC_YEAR - Number(oldAccount), teamYear = ACADEMIC_YEAR - Number(oldTeam);
    await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 학년도 학생',$1,$2,'student','unused',FALSE)", [actor, accountYear]);
    if (kind === "class") await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'합성 과탐실')", [activity, teamYear, 60 + index]);
    else await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 동아리','teacher_bootstrap')", [activity, teamYear]);
    await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,1,'합성 학년도 팀')", [team, kind === "class" ? activity : null, kind === "club" ? activity : null]);
    await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [key, team, actor]);
    await db.query("INSERT INTO inquiry_sessions(id,team_id,stage) VALUES($1,$2,'REPORTING')", [key, team]);
    const cycle = await ensureInitialCycle(db, key, "teacher_bootstrap");
    await db.query("INSERT INTO investigation_plans(id,session_id,cycle_id,form_data) VALUES($1,$1,$2,$3)", [key, cycle, JSON.stringify({ topic: "원래 계획" })]);
    await db.query("INSERT INTO reports(id,session_id,cycle_id,form_data) VALUES($1,$1,$2,$3)", [key, cycle, JSON.stringify({ title: "원래 보고서" })]);
    const before = (await db.query("SELECT * FROM team_members WHERE id=$1", [key])).rows;
    const planBefore = (await db.query("SELECT * FROM investigation_plans WHERE id=$1", [key])).rows;
    const allowed = !oldAccount && !oldTeam;
    expect.soft((await getStudentActivities(actor)).map(row => row.id)).toEqual(allowed ? [team] : []);
    expect.soft((await getInquiryDataForUser(actor, team))?.team.id ?? null).toBe(allowed ? team : null);
    expect.soft((await getInquiryDataForUser(actor))?.team.id ?? null).toBe(allowed ? team : null);
    if (allowed) await expect.soft(assertActiveTeamMember(actor, key)).resolves.toBe(team);
    else await expect.soft(assertActiveTeamMember(actor, key)).rejects.toThrow("접근");
    // Shared teacher history remains available; this change limits student entry points.
    expect((await getInquiryDataForTeam(team))?.plan.formData.topic).toBe("원래 계획");
    expect((await db.query("SELECT * FROM team_members WHERE id=$1", [key])).rows).toEqual(before);
    expect((await db.query("SELECT * FROM investigation_plans WHERE id=$1", [key])).rows).toEqual(planBefore);
  },
);
