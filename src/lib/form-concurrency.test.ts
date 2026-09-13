import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createClub, createClubTeam, enrollClubStudent, assignClubStudent } from "@/lib/clubs";
import { createClubConfigDraft, updateClubConfigDraft, publishClubConfig } from "@/lib/club-settings";
import { getCustomTabResponse, saveCustomTabResponse, reviewCustomTabResponse } from "@/lib/club-custom-tabs";
import { CORE_EVALUATION_ITEMS, createEvaluationRound, changeEvaluationRoundStatus, saveSelfEvaluation, savePeerEvaluation, getStudentEvaluationData, reviewPeerComment } from "@/lib/evaluation-service";
import { FormWriteConflict, sameFormValue } from "@/lib/form-write-conflict";

let configVersionId: string, sessionId: string, studentId: string, colleagueId: string, roundId: string;
const evaluators = ["concurrency-a", "concurrency-b", "concurrency-c"];
const responses = CORE_EVALUATION_ITEMS.map((item) => ({ itemId: item.id, value: 3 as const, reason: "" }));
const custom = (text: string, expectedVersion: number | null, submit = false) => ({ sessionId, configVersionId, responseData: { note: text }, expectedVersion, submit });
const self = (text: string, expectedVersion: number | null) => ({ roundId, responses, reflections: [text, "다음에는 기록을 공유한다"] as [string, string], expectedVersion });
const peer = (text: string, expectedVersion: number | null) => ({ roundId, evaluateeId: evaluators[1], responses, privateEvidence: "", publicComment: text, confirmed: true, expectedVersion });
function oneWinner(results: PromiseSettledResult<unknown>[]) {
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(FormWriteConflict);
}

beforeAll(async () => {
  const db = await getDb();
  const clubId = await createClub("teacher_bootstrap", "동시 저장 검증");
  configVersionId = await createClubConfigDraft("teacher_bootstrap", { clubId, configType: "custom_tab" });
  await updateClubConfigDraft("teacher_bootstrap", { versionId: configVersionId, expectedRevision: 1, title: "공동 관찰", definition: { responseMode: "team", workflow: "review", fields: [{ id: "note", kind: "long_text", label: "관찰 내용" }] } });
  await publishClubConfig("teacher_bootstrap", configVersionId, "동시 저장 검증");
  const teamId = await createClubTeam("teacher_bootstrap", clubId, "동시 저장 팀");
  studentId = (await enrollClubStudent("teacher_bootstrap", clubId, "10901", "")).studentId;
  colleagueId = (await enrollClubStudent("teacher_bootstrap", clubId, "10902", "")).studentId;
  await assignClubStudent("teacher_bootstrap", clubId, studentId, teamId);
  await assignClubStudent("teacher_bootstrap", clubId, colleagueId, teamId);
  sessionId = (await db.query("SELECT id FROM inquiry_sessions WHERE team_id = $1", [teamId])).rows[0].id;
  for (const id of evaluators) await db.query("INSERT INTO users (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password) VALUES ($1, $1, $1, 2026, 'student', 'class_2026_8', 'unused', FALSE)", [id]);
  await db.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ('concurrency-team', 'class_2026_8', 91, '검증 평가팀')");
  await db.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('concurrency-session', 'concurrency-team')");
  for (const id of evaluators) await db.query("INSERT INTO team_members (id, team_id, user_id, status) VALUES ($1, 'concurrency-team', $1, 'active')", [id]);
  roundId = await createEvaluationRound("teacher_bootstrap", { classNumber: 8, title: "동시 평가 검증", optionalItem: "none" });
  await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "open");
});

describe("custom tab conditional writes", () => {
  it("compares JSON object keys independently of order without conflating tables, objects, or value types", () => {
    expect(sameFormValue({ a: 1, b: ["x"] }, { b: ["x"], a: 1 })).toBe(true);
    expect(sameFormValue([], {})).toBe(false);
    expect(sameFormValue({ rows: [{ value: 1 }] }, { rows: [{ value: "1" }] })).toBe(false);
  });
  it("creates exactly one team response when two students first save together", async () => {
    oneWinner(await Promise.allSettled([saveCustomTabResponse(studentId, custom("첫째", null)), saveCustomTabResponse(colleagueId, custom("둘째", null))]));
    const rows = await (await getDb()).query("SELECT * FROM club_custom_responses WHERE session_id = $1", [sessionId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].write_version).toBe(1);
  });
  it("allows only one update based on the same saved version", async () => {
    oneWinner(await Promise.allSettled([saveCustomTabResponse(studentId, custom("수정 A", 1)), saveCustomTabResponse(colleagueId, custom("수정 B", 1))]));
    expect((await getCustomTabResponse(studentId, sessionId, configVersionId)).version).toBe(2);
  });
  it("rejects stale and omitted versions without changing the saved text", async () => {
    const before = await getCustomTabResponse(studentId, sessionId, configVersionId);
    await expect(saveCustomTabResponse(studentId, custom("낡은 화면", 1))).rejects.toBeInstanceOf(FormWriteConflict);
    await expect(saveCustomTabResponse(studentId, { ...custom("번호 없음", null), expectedVersion: undefined })).rejects.toBeInstanceOf(FormWriteConflict);
    expect(await getCustomTabResponse(studentId, sessionId, configVersionId)).toEqual(before);
  });
  it("reuses an identical successful save without advancing its version", async () => {
    const before = await getCustomTabResponse(studentId, sessionId, configVersionId);
    expect(await saveCustomTabResponse(studentId, { ...custom("", null), responseData: before.responseData })).toEqual({ version: before.version });
  });
  it("prevents a stale teacher review and a stale student save from replacing newer work", async () => {
    const before = await getCustomTabResponse(studentId, sessionId, configVersionId);
    const submitted = await saveCustomTabResponse(studentId, custom("검토할 원문", before.version, true));
    const id = (await (await getDb()).query("SELECT id FROM club_custom_responses WHERE session_id = $1", [sessionId])).rows[0].id;
    const changed = await saveCustomTabResponse(colleagueId, custom("수정된 원문", submitted.version, true));
    await expect(reviewCustomTabResponse("teacher_bootstrap", { responseId: id, teacherFeedback: "오래된 검토", reviewed: true, expectedVersion: submitted.version })).rejects.toBeInstanceOf(FormWriteConflict);
    await reviewCustomTabResponse("teacher_bootstrap", { responseId: id, teacherFeedback: "확인한 의견", reviewed: true, expectedVersion: changed.version });
    await expect(saveCustomTabResponse(studentId, custom("검토 덮기", changed.version))).rejects.toBeInstanceOf(FormWriteConflict);
    expect((await getCustomTabResponse(studentId, sessionId, configVersionId)).teacherFeedback).toBe("확인한 의견");
  });
  it("preserves and blocks ambiguous legacy duplicate rows", async () => {
    const db = await getDb();
    await db.query("INSERT INTO club_custom_responses (id, config_version_id, session_id, response_data) VALUES ('duplicate-legacy-custom', $1, $2, '{}')", [configVersionId, sessionId]);
    await expect(getCustomTabResponse(studentId, sessionId, configVersionId)).rejects.toThrow("중복");
    await expect(saveCustomTabResponse(studentId, custom("덮어쓰면 안 됨", null))).rejects.toThrow("중복");
    expect((await db.query("SELECT id FROM club_custom_responses WHERE session_id = $1", [sessionId])).rows).toHaveLength(2);
  });
});

describe("evaluation conditional writes", () => {
  it("allows only one simultaneous first self evaluation", async () => {
    oneWinner(await Promise.allSettled([saveSelfEvaluation(evaluators[0], self("첫 기기", null)), saveSelfEvaluation(evaluators[0], self("다른 기기", null))]));
  });
  it("rejects one of two self revisions made from the same version", async () => {
    oneWinner(await Promise.allSettled([saveSelfEvaluation(evaluators[0], self("수정 기기 A", 1)), saveSelfEvaluation(evaluators[0], self("수정 기기 B", 1))]));
    expect((await getStudentEvaluationData(evaluators[0]))?.selfEvaluation?.version).toBe(2);
  });
  it("supports zero-version legacy rows but rejects a new-form null version", async () => {
    const db = await getDb();
    await db.query("UPDATE self_evaluations SET write_version = 0 WHERE student_id = $1", [evaluators[0]]);
    await expect(saveSelfEvaluation(evaluators[0], self("잘못된 첫 저장", null))).rejects.toBeInstanceOf(FormWriteConflict);
    expect(await saveSelfEvaluation(evaluators[0], self("기존 기록 수정", 0))).toEqual({ version: 1 });
  });
  it("keeps different students' self evaluations independent", async () => {
    const saved = await Promise.all([saveSelfEvaluation(evaluators[1], self("학생 B", null)), saveSelfEvaluation(evaluators[2], self("학생 C", null))]);
    expect(saved).toEqual([{ version: 1 }, { version: 1 }]);
  });
  it("allows only one simultaneous peer save and preserves private evidence on conflict", async () => {
    oneWinner(await Promise.allSettled([savePeerEvaluation(evaluators[0], peer("의견 A", null)), savePeerEvaluation(evaluators[0], peer("의견 B", null))]));
    await savePeerEvaluation(evaluators[0], { ...peer("공개 의견", 1), privateEvidence: "교사 전용 근거" });
    await expect(savePeerEvaluation(evaluators[0], peer("오래된 의견", 1))).rejects.toBeInstanceOf(FormWriteConflict);
    const saved = (await getStudentEvaluationData(evaluators[0]))!.peerEvaluations[0];
    expect(saved).toMatchObject({ version: 2, publicComment: "공개 의견", privateEvidence: "교사 전용 근거" });
  });
  it("does not reset a reviewed comment on an identical retry after reopening", async () => {
    const db = await getDb();
    await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "close");
    const row = (await db.query("SELECT id FROM peer_evaluations WHERE evaluator_id = $1", [evaluators[0]])).rows[0];
    await reviewPeerComment("teacher_bootstrap", { evaluationId: row.id, status: "approved", redactedPublicComment: "공개 의견", expectedVersion: 2 });
    await expect(reviewPeerComment("teacher_bootstrap", { evaluationId: row.id, status: "hidden", redactedPublicComment: "", expectedVersion: 2 })).rejects.toBeInstanceOf(FormWriteConflict);
    await expect(saveSelfEvaluation(evaluators[0], self("마감 뒤 입력", 1))).rejects.toThrow("제출할 수 없습니다");
    await changeEvaluationRoundStatus("teacher_bootstrap", roundId, "reopen");
    expect(await savePeerEvaluation(evaluators[0], { ...peer("공개 의견", 1), privateEvidence: "교사 전용 근거" })).toEqual({ version: 3 });
    expect((await db.query("SELECT comment_review_status FROM peer_evaluations WHERE id = $1", [row.id])).rows[0].comment_review_status).toBe("approved");
    await expect(savePeerEvaluation(evaluators[0], peer("변경 의견", 2))).rejects.toBeInstanceOf(FormWriteConflict);
  });
});
