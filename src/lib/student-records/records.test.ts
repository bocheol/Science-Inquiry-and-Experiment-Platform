import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { assertRecordStudent, teacherRecordStudents, type RecordActor } from "./access";
import { getRecordWorkspace, recordHistory, returnRecordSubmission, saveRecordDraft, saveRecordSettings, saveRecordSubmission } from "./service";
import { combinedRecordBytes, recordBytes, submissionSchema, suggestStudentFromFilename } from "./model";
import { confirmRecordFile, getRecordFile, parseRecordFile, setRecordFileIncluded, uploadRecordFile } from "./files";
import { collectRecordEvidence } from "./evidence";
import { validateCourseAiResult } from "./ai";

const teacher: RecordActor = { id: "teacher_bootstrap", role: "teacher", mustChangePassword: false };
const other: RecordActor = { id: "record_other_teacher", role: "teacher", mustChangePassword: false };
const student: RecordActor = { id: "demo_student_1", role: "student", mustChangePassword: false };
const peer: RecordActor = { id: "demo_student_2", role: "student", mustChangePassword: false };

beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO record_teacher_classes (class_id, teacher_id) VALUES ('class_2026_9', $1)", [teacher.id]);
  await db.query("INSERT INTO users (id,name,login_id,academic_year,role,password_hash,must_change_password,is_master) VALUES ($1,'별도 교사','record-other',2026,'teacher','unused',FALSE,TRUE)", [other.id]);
  await db.query("INSERT INTO users (id,name,login_id,academic_year,role,class_id,password_hash,must_change_password,account_type) VALUES ('record_demo','체험 계정','demo-record',2026,'student','class_2026_9','unused',FALSE,'demo')");
  await db.query("UPDATE team_members SET joined_at = '2026-09-01' WHERE team_id = 'demo_team_1'");
  const cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id = 'demo_session_1'")).rows[0].id;
  await db.query("UPDATE investigation_plans SET form_data = $1 WHERE id = 'demo_plan_1'", [JSON.stringify({ topic: "과탐실2 전용 팀계획", expectedResult: "아직 수행하지 않은 예상 결과" })]);
  await db.query("UPDATE reports SET form_data = $1 WHERE id = 'report_demo_session_1'", [JSON.stringify({ analysis: "공동 결과 분석" })]);
  await db.query("INSERT INTO report_member_roles (report_id,user_id,role_description) VALUES ('report_demo_session_1',$1,'이 학생의 측정 역할'),('report_demo_session_1',$2,'다른 학생의 비공개 역할 설명')", [student.id, peer.id]);
  await db.query(`INSERT INTO experiment_journals (id,session_id,cycle_id,student_id,session_number,journal_date,activities,observations,reflections)
    VALUES ('record_own_journal','demo_session_1',$1,$2,91,'2026-10-01','본인의 관찰 일지','측정','다음 질문'),
           ('record_peer_journal','demo_session_1',$1,$3,91,'2026-10-01','절대 노출하지 않을 다른 학생 일지','개인 관찰','개인 성찰')`, [cycle, student.id, peer.id]);
});

describe("records boundaries and privacy", () => {
  it("counts normalized UTF-8 with an exact 1500-byte combined boundary", () => {
    expect(recordBytes("가A\r\n🙂")).toBe(9);
    expect(combinedRecordBytes("가".repeat(400), "A".repeat(300))).toBe(1500);
    expect(combinedRecordBytes("가".repeat(400), "A".repeat(301))).toBe(1501);
  });
  it("allows blank optional comments, but enforces 2–3 course-one activities and 300 Unicode characters", () => {
    expect(submissionSchema.safeParse({ expectedRevision: 0, selected: ["egg", "spectrum"], comments: { egg: "" }, submit: true }).success).toBe(true);
    expect(submissionSchema.safeParse({ expectedRevision: 0, selected: ["egg", "team_plan"], comments: {}, submit: true }).success).toBe(false);
    expect(submissionSchema.safeParse({ expectedRevision: 0, selected: ["egg"], comments: {}, submit: true }).success).toBe(false);
    expect(submissionSchema.safeParse({ expectedRevision: 0, selected: ["egg", "spectrum"], comments: { egg: "🙂".repeat(300) }, submit: true }).success).toBe(true);
    expect(submissionSchema.safeParse({ expectedRevision: 0, selected: ["egg", "spectrum"], comments: { egg: "가".repeat(301) }, submit: true }).success).toBe(false);
  });
  it("only suggests unique filename matches", () => {
    const roster = [{ id: "a", loginId: "10901", name: "동명이인" }, { id: "b", loginId: "10902", name: "동명이인" }];
    expect(suggestStudentFromFilename("10901_계획서.hwp", roster)).toBe("a");
    expect(suggestStudentFromFilename("동명이인.pdf", roster)).toBe("");
    expect(suggestStudentFromFilename("110901_제목.pdf", roster)).toBe("");
  });
  it("denies peers and nonassigned masters, including stale account objects", async () => {
    const db = await getDb();
    await expect(assertRecordStudent(db, peer, student.id)).rejects.toMatchObject({ status: 403 });
    await expect(getRecordWorkspace(other, student.id)).rejects.toMatchObject({ status: 403 });
    expect(await teacherRecordStudents(other)).toEqual([]);
    expect((await teacherRecordStudents(teacher)).map(s => s.classNumber)).toEqual([9, 9, 9]);
    // A demo remains excluded from the export roster and direct access even if
    // it happens to have a class assignment.
    await expect(getRecordWorkspace(teacher, "record_demo")).rejects.toMatchObject({ status: 403 });
    await expect(getRecordWorkspace({ ...student, id: "record_demo" }, "record_demo")).rejects.toMatchObject({ status: 403 });
    await expect(uploadRecordFile(teacher, "record_demo", "individual_plan", "demo.pdf", Buffer.from("%PDF-1.7\nsynthetic"))).rejects.toMatchObject({ status: 403 });
    await db.query("UPDATE users SET status = 'inactive' WHERE id = $1", [student.id]);
    await expect(getRecordWorkspace(student, student.id)).rejects.toMatchObject({ status: 403 });
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [student.id]);
  });
  it("preserves immutable submissions and refuses stale revisions", async () => {
    await saveRecordSubmission(student, student.id, { expectedRevision: 0, selected: ["individual_plan", "egg"], comments: { egg: "과탐실1 전용 달걀 활동 설명" }, submit: true });
    const before = await recordHistory(teacher, student.id);
    await expect(saveRecordSubmission(student, student.id, { expectedRevision: 0, selected: ["egg", "spectrum"], comments: {}, submit: true })).rejects.toMatchObject({ status: 409 });
    expect(await recordHistory(teacher, student.id)).toEqual(before);
    await expect(recordHistory(student, student.id)).rejects.toMatchObject({ status: 403 });
  });
  it("separates course sources, private journals, team roles and missing exam answers", async () => {
    const evidence = await collectRecordEvidence(await getDb(), teacher, student.id);
    const one = JSON.stringify(evidence.sources.filter(s => s.course === 1));
    const two = JSON.stringify(evidence.sources.filter(s => s.course === 2));
    expect(one).toContain("과탐실1 전용"); expect(one).not.toContain("과탐실2 전용");
    expect(two).toContain("과탐실2 전용"); expect(two).not.toContain("과탐실1 전용");
    expect(two).toContain("본인의 관찰 일지"); expect(two).toContain("이 학생의 측정 역할");
    expect(two).not.toContain("절대 노출하지 않을"); expect(two).not.toContain("다른 학생의 비공개 역할");
    expect(evidence.missing.some(m => m.includes("개별 시험"))).toBe(true);
    expect(() => validateCourseAiResult(1, { sentences: [{ text: "섞인 문장", evidenceIds: [evidence.sources.find(s => s.course === 2)!.id] }], warnings: [] }, evidence.sources)).toThrow("근거 연결");
  });
  it("stores originals once and keeps unconfirmed extraction out of usable evidence", async () => {
    const bytes = Buffer.from("%PDF-1.7\nsynthetic damaged original preserved");
    const first = await uploadRecordFile(student, student.id, "individual_plan", "10901_계획.pdf", bytes);
    const repeated = await uploadRecordFile(teacher, student.id, "individual_plan", "복사본.pdf", bytes);
    expect(repeated).toEqual({ id: first.id, duplicate: true });
    await expect(getRecordFile(peer, first.id)).rejects.toMatchObject({ status: 403 });
    await expect(getRecordFile(other, first.id)).rejects.toMatchObject({ status: 403 });
    expect(Buffer.from((await getRecordFile(student, first.id)).file_data)).toEqual(bytes);
    await expect(confirmRecordFile(student, first.id, 1, "학생이 스스로 확인하려는 내용")).rejects.toMatchObject({ status: 403 });
    await confirmRecordFile(teacher, first.id, 1, "과탐실1 계획한 방법과 예상 결과");
    await expect(parseRecordFile(student, first.id, 2)).rejects.toMatchObject({ status: 409 });
    expect((await getRecordFile(student, first.id)).extraction_status).toBe("ready");
  });
  it("locks deadlines, allows explicit teacher return, and preserves old submission snapshots", async () => {
    await saveRecordSettings(teacher, { expectedRevision: 0, style: "교사 전용 문체 기준", opensAt: null, deadlineAt: "2020-01-01T00:00:00.000Z" });
    let workspace = await getRecordWorkspace(student, student.id);
    await expect(saveRecordSubmission(student, student.id, { expectedRevision: workspace.submission.revision, selected: ["egg", "spectrum"], comments: {}, submit: true })).rejects.toMatchObject({ status: 409 });
    const previousHistory = await recordHistory(teacher, student.id);
    await returnRecordSubmission(teacher, student.id, { expectedRevision: workspace.submission.revision, note: "본인의 역할을 보완해 주세요.", reopenedUntil: new Date(Date.now() + 86400_000).toISOString() });
    workspace = await getRecordWorkspace(student, student.id);
    await saveRecordSubmission(student, student.id, { expectedRevision: workspace.submission.revision, selected: ["individual_plan", "egg"], comments: { egg: "과탐실1 추가 설명" }, submit: true });
    expect((await recordHistory(teacher, student.id)).submissions.at(-1)).toEqual(previousHistory.submissions.at(-1));
    expect(workspace.settings.style).toBe(""); expect(workspace.settings.spreadsheetId).toBe(""); expect(workspace.draft).toBeUndefined();
  });
  it("protects teacher drafts, detects changed source, and rejects over-budget finalization", async () => {
    const workspace = await getRecordWorkspace(teacher, student.id);
    const input = { expectedRevision: 0, expectedSubmissionRevision: workspace.submission.revision, expectedEvidenceHash: workspace.evidence!.hash, course1: "가".repeat(400), course2: "A".repeat(300), notes: "답안은 아직 받지 못해 시험 활용을 보류함.", checkedGroups: ["team_plan", "journal", "team_report", "exam"], finalize: true };
    await expect(saveRecordDraft(teacher, student.id, { ...input, course2: input.course2 + "A" })).rejects.toThrow("1,500");
    await expect(saveRecordDraft(student, student.id, input)).rejects.toMatchObject({ status: 403 });
    await saveRecordDraft(teacher, student.id, input);
    const own = await getRecordWorkspace(student, student.id);
    expect(JSON.stringify(own)).not.toContain("답안은 아직 받지"); expect(own.draft).toBeUndefined();
    await (await getDb()).query("UPDATE experiment_journals SET activities = '저장 후 바뀐 본인 관찰' WHERE id = 'record_own_journal'");
    await expect(saveRecordDraft(teacher, student.id, { ...input, expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await recordHistory(teacher, student.id)).drafts).toHaveLength(1);
  });
  it("does not attribute later team edits to a departed student", async () => {
    const db = await getDb();
    const cycle = (await db.query("SELECT id FROM inquiry_cycles WHERE session_id = 'demo_session_1'")).rows[0].id;
    await db.query("INSERT INTO document_revisions (id,document_type,document_id,cycle_id,snapshot,action,changed_by,created_at) VALUES ('record_old_plan','plan','demo_plan_1',$1,$2,'save',$3,'2026-09-02')", [cycle, JSON.stringify({ formData: { topic: "참여 기간의 과거 계획" } }), student.id]);
    await db.query("UPDATE team_members SET status = 'inactive', left_at = '2026-09-03' WHERE user_id = $1", [student.id]);
    const evidence = await collectRecordEvidence(db, teacher, student.id);
    expect(JSON.stringify(evidence)).toContain("참여 기간의 과거 계획");
    expect(JSON.stringify(evidence)).not.toContain("과탐실2 전용 팀계획");
    expect(JSON.stringify(evidence)).toContain("저장 후 바뀐 본인 관찰");
  });
  it("can withdraw a misfiled original from the student and AI without deleting its teacher archive", async () => {
    const workspace = await getRecordWorkspace(teacher, student.id);
    const file = workspace.files[0];
    await expect(setRecordFileIncluded(student, file.id, file.revision, false)).rejects.toMatchObject({ status: 403 });
    await setRecordFileIncluded(teacher, file.id, file.revision, false);
    await expect(getRecordFile(student, file.id)).rejects.toMatchObject({ status: 403 });
    expect((await getRecordWorkspace(student, student.id)).files).toHaveLength(0);
    expect((await collectRecordEvidence(await getDb(), teacher, student.id)).sources.some(s => s.id === "file:" + file.id)).toBe(false);
    const archived = await getRecordFile(teacher, file.id); expect(archived.file_data.length).toBeGreaterThan(0);
    await setRecordFileIncluded(teacher, file.id, archived.revision, true);
    expect((await getRecordFile(student, file.id)).included).toBe(true);
  });
});
