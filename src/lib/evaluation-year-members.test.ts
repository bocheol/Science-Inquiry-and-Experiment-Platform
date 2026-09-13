import { expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { removeStudent } from "@/lib/teams";
import { reviewPeerComment } from "@/lib/evaluation-service";
import { CORE_EVALUATION_ITEMS, getStudentEvaluationData, saveSelfEvaluation, savePeerEvaluation, getEvaluationManagementData, getClubEvaluationManagementData, saveEvaluationTeacherSummary, publishEvaluationRound } from "@/lib/evaluation-service";

async function fixture(key: string, club: boolean, year: number, number: number) {
  const db = await getDb();
  if (club) {
    await db.query("INSERT INTO clubs(id,academic_year,name,created_by) VALUES($1,$2,'합성 평가 동아리','teacher_bootstrap')", [key, year]);
    await db.query("INSERT INTO club_teacher_assignments(club_id,teacher_id,assigned_by) VALUES($1,'teacher_bootstrap','teacher_bootstrap')", [key]);
  } else await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,$2,$3,'합성 평가 학급')", [key, year, number]);
  await db.query("INSERT INTO teams(id,class_id,club_id,team_number,name) VALUES($1,$2,$3,1,'합성 평가팀')", [key, club ? null : key, club ? key : null]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [key]);
  await db.query("INSERT INTO evaluation_templates(id,academic_year,created_by) VALUES($1,$2,'teacher_bootstrap')", [key, year]);
  await db.query("INSERT INTO evaluation_rounds(id,class_id,club_id,template_id,title,status,template_snapshot) VALUES($1,$2,$3,$1,'합성 평가','open',$4)", [key, club ? null : key, club ? key : null, JSON.stringify({ items: CORE_EVALUATION_ITEMS, selfReflectionQuestions: ["질문1", "질문2"] })]);
}
async function member(key: string, id: string, year: number) {
  const db = await getDb();
  await db.query("INSERT INTO users(id,name,login_id,academic_year,role,password_hash,must_change_password) VALUES($1,'합성 학생',$1,$2,'student','unused',FALSE)", [id, year]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$1)", [id, key]);
}
const responses = CORE_EVALUATION_ITEMS.map(item => ({ itemId: item.id, value: 3 as const, reason: "" }));
it.each([false, true])("preserves valid submitted ratings after an evaluator leaves club=%s", async club => {
  const db = await getDb(), key = `evaluation_departed_${club}`;
  await fixture(key, club, ACADEMIC_YEAR, 408);
  if (!club) {
    const classId = `class_${ACADEMIC_YEAR}_6`;
    await db.query("UPDATE teams SET class_id=$1 WHERE id=$2", [classId, key]);
    await db.query("UPDATE evaluation_rounds SET class_id=$1 WHERE id=$2", [classId, key]);
  }
  const ids = [0, 1, 2, 3].map(index => `${key}_${index}`);
  for (const id of ids) await member(key, id, ACADEMIC_YEAR);
  for (const id of ids.slice(1)) {
    await savePeerEvaluation(id, { roundId: key, evaluateeId: ids[0], responses, privateEvidence: "", publicComment: id === ids[3] ? "관찰 자료를 함께 확인했습니다." : "", confirmed: true, expectedVersion: null });
  }
  const departedRow = (await db.query("SELECT id, write_version FROM peer_evaluations WHERE round_id=$1 AND evaluator_id=$2", [key, ids[3]])).rows[0];
  await db.query("UPDATE evaluation_rounds SET status='reviewing' WHERE id=$1", [key]);
  await reviewPeerComment("teacher_bootstrap", { evaluationId: departedRow.id, status: "approved", redactedPublicComment: "관찰 자료를 함께 확인했습니다.", expectedVersion: departedRow.write_version });
  await db.query("UPDATE evaluation_rounds SET status='open' WHERE id=$1", [key]);
  const readPeers = async () => (await db.query("SELECT * FROM peer_evaluations WHERE round_id=$1 ORDER BY id", [key])).rows;
  const before = await readPeers();
  await removeStudent("teacher_bootstrap", ids[3], key);
  const membership = (await db.query("SELECT * FROM team_members WHERE user_id=$1", [ids[3]])).rows;
  expect(membership[0]).toMatchObject({ status: "inactive" });
  expect(membership[0].left_at).toBeTruthy();
  await expect(savePeerEvaluation(ids[3], { roundId: key, evaluateeId: ids[0], responses, privateEvidence: "", publicComment: "", confirmed: true, expectedVersion: 2 })).rejects.toMatchObject({ status: 403 });
  const data = club ? await getClubEvaluationManagementData("teacher_bootstrap", key, key) : await getEvaluationManagementData(6, key, "teacher_bootstrap");
  expect(data.selected?.progress.some(row => row.studentId === ids[3])).toBe(false);
  expect(data.selected?.progress.find(row => row.studentId === ids[0])).toMatchObject({ peerReceived: 3, disclosureEligible: true, validCounts: Object.fromEntries(CORE_EVALUATION_ITEMS.map(item => [item.id, 3])) });
  expect(data.selected?.peerEvaluations.some(row => row.id === departedRow.id)).toBe(true);
  await db.query("UPDATE evaluation_rounds SET status='reviewing' WHERE id=$1", [key]);
  for (const id of ids.slice(1, 3)) await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: key, studentId: id, teacherSummary: "관찰 근거를 함께 확인했습니다.", expectedVersion: null });
  expect(await publishEvaluationRound("teacher_bootstrap", key)).toEqual({ published: true, studentCount: 3 });
  const published = (await getStudentEvaluationData(ids[0], key))?.result;
  expect(published).toMatchObject({ peerAverages: Object.fromEntries(CORE_EVALUATION_ITEMS.map(item => [item.id, 3])), approvedComments: ["관찰 자료를 함께 확인했습니다."] });
  expect((await db.query("SELECT student_id FROM evaluation_publications WHERE round_id=$1 AND student_id=$2", [key, ids[3]])).rows).toHaveLength(0);
  expect(await readPeers()).toEqual(before);
  expect((await db.query("SELECT * FROM team_members WHERE user_id=$1", [ids[3]])).rows).toEqual(membership);
});
it.each([false, true].flatMap(club => [false, true].flatMap(oldTeam => [false, true].map(oldStudent => ({ club, oldTeam, oldStudent })))))(
  "student read/write club=$club oldTeam=$oldTeam oldStudent=$oldStudent", async ({ club, oldTeam, oldStudent }) => {
    const db = await getDb(), key = `evaluation_member_${club}_${oldTeam}_${oldStudent}`, id = `${key}_student`;
    await fixture(key, club, ACADEMIC_YEAR - Number(oldTeam), 401 + Number(oldStudent));
    await member(key, id, ACADEMIC_YEAR - Number(oldStudent));
    const readMembers = async () => (await db.query("SELECT * FROM team_members WHERE team_id=$1", [key])).rows;
    const before = await readMembers();
    const read = getStudentEvaluationData(id, key);
    if (oldTeam || oldStudent) await expect(read).rejects.toMatchObject({ status: 403 });
    else expect(await read).toMatchObject({ round: { id: key } });
    const save = saveSelfEvaluation(id, { roundId: key, responses, reflections: ["합성 성찰1", "합성 성찰2"], expectedVersion: null });
    if (oldTeam || oldStudent) { await expect(save).rejects.toMatchObject({ status: 403 }); expect((await db.query("SELECT id FROM self_evaluations WHERE round_id=$1", [key])).rows).toHaveLength(0); }
    else { await save; expect((await db.query("SELECT id FROM self_evaluations WHERE round_id=$1", [key])).rows).toHaveLength(1); }
    expect(await readMembers()).toEqual(before);
  },
);
it.each([false, true])("current roster and publication exclude historical accounts club=%s", async club => {
  const db = await getDb(), key = `evaluation_roster_${club}`, current = `${key}_current`, old = `${key}_old`;
  // Use an existing current class number for the public management entry point.
  const classRow = await db.query("SELECT id FROM classes WHERE academic_year=$1 AND class_number=7", [ACADEMIC_YEAR]);
  await fixture(key, club, ACADEMIC_YEAR, 407);
  if (!club) { await db.query("UPDATE teams SET class_id=$1 WHERE id=$2", [classRow.rows[0].id, key]); await db.query("UPDATE evaluation_rounds SET class_id=$1 WHERE id=$2", [classRow.rows[0].id, key]); }
  await member(key, current, ACADEMIC_YEAR); await member(key, old, ACADEMIC_YEAR - 1);
  const historical = async () => (await db.query("SELECT * FROM team_members WHERE user_id=$1", [old])).rows;
  const before = await historical();
  const data = club ? await getClubEvaluationManagementData("teacher_bootstrap", key, key) : await getEvaluationManagementData(7, key, "teacher_bootstrap");
  expect.soft(data.selected?.progress.filter(row => row.teamId === key).map(row => row.studentId)).toEqual([current]);
  expect.soft((await getStudentEvaluationData(current, key))?.teammates).toEqual([]);
  await expect(savePeerEvaluation(current, { roundId: key, evaluateeId: old, responses, privateEvidence: "", publicComment: "", confirmed: true, expectedVersion: null })).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE evaluation_rounds SET status='reviewing' WHERE id=$1", [key]);
  await expect(saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: key, studentId: old, teacherSummary: "잘못된 대상", expectedVersion: null })).rejects.toMatchObject({ status: 404 });
  await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: key, studentId: current, teacherSummary: "합성 피드백", expectedVersion: null });
  expect(await publishEvaluationRound("teacher_bootstrap", key)).toEqual({ published: true, studentCount: 1 });
  expect((await db.query("SELECT student_id FROM evaluation_publications WHERE round_id=$1", [key])).rows).toEqual([{ student_id: current }]);
  expect(await historical()).toEqual(before);
});

it("preserves a moved evaluatee's old responses without mixing them into the new team result", async () => {
  const db = await getDb();
  const key = "evaluation_moved_evaluatee";
  const classId = `class_${ACADEMIC_YEAR}_8`;
  await fixture(key, false, ACADEMIC_YEAR, 498);
  await db.query("UPDATE teams SET class_id=$1 WHERE id=$2", [classId, key]);
  await db.query("UPDATE evaluation_rounds SET class_id=$1 WHERE id=$2", [classId, key]);
  const ids = [0, 1, 2, 3].map(index => `${key}_${index}`);
  for (const id of ids) await member(key, id, ACADEMIC_YEAR);
  for (const evaluatorId of ids.slice(1)) {
    await savePeerEvaluation(evaluatorId, { roundId: key, evaluateeId: ids[0], responses, privateEvidence: "", publicComment: evaluatorId === ids[3] ? "이전 팀에서 관찰한 합성 의견" : "", confirmed: true, expectedVersion: null });
  }
  const before = (await db.query("SELECT * FROM peer_evaluations WHERE round_id=$1 ORDER BY id", [key])).rows;
  const newTeamId = `${key}_new_team`;
  await db.query("INSERT INTO teams(id,class_id,team_number,name) VALUES($1,$2,20,'합성 이동팀')", [newTeamId, classId]);
  await db.query("INSERT INTO inquiry_sessions(id,team_id) VALUES($1,$1)", [newTeamId]);
  await db.query("UPDATE team_members SET status='inactive',left_at=CURRENT_TIMESTAMP WHERE team_id=$1 AND user_id=$2", [key, ids[0]]);
  await db.query("INSERT INTO team_members(id,team_id,user_id) VALUES($1,$2,$3)", [`${key}_moved_membership`, newTeamId, ids[0]]);

  const management = await getEvaluationManagementData(8, key, "teacher_bootstrap");
  expect(management.selected?.progress.find(row => row.studentId === ids[0])).toMatchObject({ teamId: newTeamId, peerReceived: 0, disclosureEligible: false });
  expect(management.selected?.peerEvaluations.filter(row => row.evaluateeId === ids[0])).toHaveLength(3);

  await db.query("UPDATE evaluation_rounds SET status='reviewing' WHERE id=$1", [key]);
  for (const studentId of ids) {
    await saveEvaluationTeacherSummary("teacher_bootstrap", { roundId: key, studentId, teacherSummary: "현재 팀 기준 교사 종합 의견", expectedVersion: null });
  }
  expect(await publishEvaluationRound("teacher_bootstrap", key)).toEqual({ published: true, studentCount: 4 });
  expect((await getStudentEvaluationData(ids[0], newTeamId))?.result).toMatchObject({ peerAverages: {}, approvedComments: [], teacherSummary: "현재 팀 기준 교사 종합 의견" });
  expect((await db.query("SELECT * FROM peer_evaluations WHERE round_id=$1 ORDER BY id", [key])).rows).toEqual(before);
});
