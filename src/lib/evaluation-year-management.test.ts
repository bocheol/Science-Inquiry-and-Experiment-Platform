import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { CORE_EVALUATION_ITEMS, updateEvaluationTemplate, changeEvaluationRoundStatus, saveEvaluationTeacherSummary, reviewPeerComment, publishEvaluationRound } from "@/lib/evaluation-service";

it.each(["template", "open", "close", "reopen", "summary", "comment", "publish"].flatMap((action, index) => (action === "template" ? [false] : [false, true]).flatMap(club => [false, true].map(old => ({ action, index, club, old })))))(
  "$action club=$club oldYear=$old preserves historical evaluation records", async ({ action, index, club, old }) => {
    const db = await getDb(), key = `evaluation_year_${action}_${club}_${old}`, student = `${key}_student`, peer = `${key}_peer`, year = ACADEMIC_YEAR - Number(old);
    if (club) {
      await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 평가 동아리','teacher_bootstrap')", [key, year]);
      await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
    } else await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'합성 평가 학급')", [key, year, 301 + index]);
    for (const id of [student, peer]) await db.query("INSERT INTO users(id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES($1,'합성 평가 학생',$1,$2,'student',$3,'unused',FALSE)", [id, year, club ? null : key]);
    await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,1,'합성 평가팀')", [key, club ? null : key, club ? key : null]);
    await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$1,$2)", [key, student]);
    await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
    await db.query("INSERT INTO evaluation_templates(id,academic_year,created_by) VALUES($1,$2,'teacher_bootstrap')", [key, year]);
    const status = ["template", "open"].includes(action) ? "draft" : action === "close" ? "open" : "reviewing";
    await db.query("INSERT INTO evaluation_rounds(id,class_id,club_id,template_id,title,status,template_snapshot) VALUES($1,$2,$3,$1,'원래 합성 평가',$4,$5)", [key, club ? null : key, club ? key : null, status, JSON.stringify({ items: CORE_EVALUATION_ITEMS, selfReflectionQuestions: ["합성 질문1", "합성 질문2"] })]);
    await db.query("INSERT INTO peer_evaluations(id,round_id,session_id,evaluator_id,evaluatee_id,responses,public_comment,comment_review_status) VALUES($1,$1,$1,$2,$3,'[]','합성 의견',$4)", [key, peer, student, action === "comment" ? "pending" : "hidden"]);
    await db.query("INSERT INTO evaluation_publications(id,round_id,session_id,student_id,teacher_summary) VALUES($1,$1,$1,$2,'기존 합성 피드백')", [key, student]);
    const read = async () => ({
      template: (await db.query("SELECT * FROM evaluation_templates WHERE id=$1", [key])).rows,
      round: (await db.query("SELECT * FROM evaluation_rounds WHERE id=$1", [key])).rows,
      peer: (await db.query("SELECT * FROM peer_evaluations WHERE id=$1", [key])).rows,
      published: (await db.query("SELECT * FROM evaluation_publications WHERE round_id=$1 ORDER BY id", [key])).rows,
      session: (await db.query("SELECT * FROM inquiry_sessions WHERE id=$1", [key])).rows,
      members: (await db.query("SELECT * FROM team_members WHERE team_id=$1", [key])).rows,
    });
    const before = await read();
    const work = action === "template" ? updateEvaluationTemplate("teacher_bootstrap", { roundId: key, title: "수정 합성 평가", items: CORE_EVALUATION_ITEMS })
      : action === "summary" ? saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: key, studentId: student, teacherSummary: "수정 합성 피드백", expectedVersion: 0 })
      : action === "comment" ? reviewPeerComment("teacher_bootstrap", { evaluationId: key, status: "approved", redactedPublicComment: "검토 합성 의견", expectedVersion: 0 })
      : action === "publish" ? publishEvaluationRound("teacher_bootstrap", key)
      : changeEvaluationRoundStatus("teacher_bootstrap", key, action as "open" | "close" | "reopen");
    if (old) {
      await expect(work).rejects.toMatchObject({ status: expect.any(Number) });
      expect(await read()).toEqual(before);
    } else {
      await work;
      const after = await read();
      expect(after.members).toEqual(before.members);
      if (action === "template") expect(after.round[0].title).toBe("수정 합성 평가");
      if (action === "open" || action === "reopen") expect(after.round[0].status).toBe("open");
      if (action === "close") expect(after.round[0].status).toBe("reviewing");
      if (action === "summary") expect(after.published[0].teacher_summary).toBe("수정 합성 피드백");
      if (action === "comment") expect(after.peer[0].redacted_public_comment).toBe("검토 합성 의견");
      if (action === "publish") { expect(after.round[0].status).toBe("published"); expect(after.published[0].published_at).not.toBeNull(); expect(after.published[0].teacher_summary).toBe("기존 합성 피드백"); }
    }
  },
);
