import { beforeAll, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { listStudentJournals, saveStudentJournal, type SaveJournalInput } from "@/lib/journal-service";
import type { SessionUser } from "@/lib/types";
import { ensureInitialCycle } from "@/lib/inquiry-cycles";

const student: SessionUser = {
  id: "journal_concurrency_student", name: "합성 학생", loginId: "journal-concurrency", role: "student",
  academicYear: 2026, classId: "class_2026_2", classNumber: 2, mustChangePassword: false,
};
const sessionId = "journal_concurrency_session";
const base = (sessionNumber: number, activities: string, expectedVersion: number | null, extras: Partial<SaveJournalInput> = {}): SaveJournalInput => ({
  sessionId, sessionNumber, date: "2026-09-07", activities, observations: "합성 관찰", reflections: "합성 성찰",
  expectedVersion, existingImageIds: [], photos: [], ...extras,
});

beforeAll(async () => {
  const db = await getDb();
  await db.query("INSERT INTO users (id,name,login_id,academic_year,role,class_id,password_hash,must_change_password) VALUES ($1,$2,$3,2026,'student','class_2026_2','unused',FALSE)", [student.id, student.name, student.loginId]);
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ('journal_concurrency_team','class_2026_2',98,'합성일지팀')");
  await db.query("INSERT INTO team_members (id,team_id,user_id) VALUES ('journal_concurrency_member','journal_concurrency_team',$1)", [student.id]);
  await db.query("INSERT INTO inquiry_sessions (id,team_id,stage) VALUES ($1,'journal_concurrency_team','EXPERIMENTING')", [sessionId]);
  const cycleId = await ensureInitialCycle(db, sessionId, "teacher_bootstrap");
  await db.query("INSERT INTO investigation_plans (id,session_id,cycle_id,review_status) VALUES ('journal_concurrency_plan',$1,$2,'approved')", [sessionId, cycleId]);
  await db.query("INSERT INTO material_requests (id,submission_id,session_id,cycle_id,team_id,submitted_by,form_data) VALUES ('journal_concurrency_material','journal-concurrency-material',$1,$2,'journal_concurrency_team',$3,'[]')", [sessionId, cycleId, student.id]);
});

it("allows only one different first save from the same null base", async () => {
  await saveStudentJournal(student, base(11, "첫 기기", null));
  await expect(saveStudentJournal(student, base(11, "둘째 기기", null))).rejects.toBeInstanceOf(FormWriteConflict);
  const saved = (await listStudentJournals(student, sessionId)).find(item => item.sessionNumber === 11)!;
  expect(saved.version).toBe(1);
  expect(saved.activities).toBe("첫 기기");
});

it("allows only one write from the same version and leaves no losing photo mutation", async () => {
  const initial = await saveStudentJournal(student, base(12, "초기", null, { photos: [{ clientId: "initial-photo", contentType: "image/jpeg", fileName: "initial.jpg", data: Buffer.from("initial") }] }));
  const originalId = initial.images[0]!.id;
  const outcomes = await Promise.allSettled([
    saveStudentJournal(student, base(12, "사진 유지", initial.version, { existingImageIds: [originalId] })),
    saveStudentJournal(student, base(12, "사진 교체", initial.version, { photos: [{ clientId: "replacement-photo", contentType: "image/png", fileName: "replacement.png", data: Buffer.from("replacement") }] })),
  ]);
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(1);
  const saved = (await listStudentJournals(student, sessionId)).find(item => item.sessionNumber === 12)!;
  expect(saved.version).toBe(2);
  expect(saved.activities === "사진 유지" ? saved.images.map(image => image.id) : saved.images.map(image => image.clientId))
    .toEqual(saved.activities === "사진 유지" ? [originalId] : ["replacement-photo"]);
});

it("treats an applied photo upload with a lost response as an idempotent retry", async () => {
  const payload = base(13, "응답 유실", null, { photos: [{ clientId: "lost-response-photo", contentType: "image/webp", fileName: "lost.webp", data: Buffer.from("same-photo") }] });
  const first = await saveStudentJournal(student, payload);
  const retry = await saveStudentJournal(student, payload);
  expect(retry.version).toBe(first.version);
  expect(retry.updatedAt).toBe(first.updatedAt);
  expect(retry.images).toHaveLength(1);
});

it("rejects stale text and photo deletions without changing either", async () => {
  const initial = await saveStudentJournal(student, base(14, "보존할 글", null, { photos: [{ clientId: "kept-photo", contentType: "image/jpeg", fileName: "kept.jpg", data: Buffer.from("kept") }] }));
  const changed = await saveStudentJournal(student, base(14, "최신 글", initial.version, { existingImageIds: [initial.images[0]!.id] }));
  await expect(saveStudentJournal(student, base(14, "오래된 글", initial.version))).rejects.toBeInstanceOf(FormWriteConflict);
  const saved = (await listStudentJournals(student, sessionId)).find(item => item.sessionNumber === 14)!;
  expect(saved).toMatchObject({ activities: "최신 글", version: changed.version });
  expect(saved.images.map(image => image.clientId)).toEqual(["kept-photo"]);
});

it("requires version zero for legacy rows and then increments once", async () => {
  const db = await getDb();
  const cycleId = (await db.query<{ id: string }>("SELECT id FROM inquiry_cycles WHERE session_id = $1 AND status = 'active'", [sessionId])).rows[0]!.id;
  await db.query(`INSERT INTO experiment_journals (id,session_id,cycle_id,student_id,session_number,journal_date,activities,observations,reflections)
    VALUES ('legacy_concurrency_journal',$1,$2,$3,15,'2026-09-07','과거','관찰','성찰')`, [sessionId, cycleId, student.id]);
  await expect(saveStudentJournal(student, base(15, "변경", null))).rejects.toBeInstanceOf(FormWriteConflict);
  const updated = await saveStudentJournal(student, base(15, "변경", 0));
  expect(updated.version).toBe(1);
});
