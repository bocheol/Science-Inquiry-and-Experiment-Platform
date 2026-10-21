import { z } from "zod";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { assertRecordActor, assertRecordEvidenceAccess, assertRecordStudent, assertRecordWritable, iso, parseValue, RecordError, RecordEvidenceUnavailable, recordSettings, recordTransaction, type RecordActor, type RecordDb } from "./access";
import { collectRecordEvidence } from "./evidence";
import { draftSchema, submissionSchema, type RecordDraft, type RecordFile, type RecordSubmission, type RecordWorkspace } from "./model";

export async function recordSubmission(db: RecordDb, studentId: string): Promise<RecordSubmission> {
  const row = (await db.query<{ revision: number; selected: RecordSubmission["selected"]; comments: RecordSubmission["comments"]; status: string; returned_note: string; reopened_until: Date | null }>("SELECT * FROM record_submissions WHERE student_id = $1", [studentId])).rows[0];
  return { studentId, revision: row?.revision ?? 0, selected: parseValue(row?.selected ?? []), comments: parseValue(row?.comments ?? {}), status: row?.status ?? "draft", returnedNote: row?.returned_note ?? "", reopenedUntil: iso(row?.reopened_until ?? null) };
}

export async function recordFiles(db: RecordDb, studentId: string): Promise<RecordFile[]> {
  const rows = (await db.query<{ id: string; activity: RecordFile["activity"]; course: 1 | 2; file_name: string; mime_type: string; byte_size: number; revision: number; extraction_status: string; extracted_text: string; extraction_note: string; drive_status: string; created_at: Date; included: boolean }>(
    "SELECT id, activity, course, file_name, mime_type, byte_size, revision, extraction_status, extracted_text, extraction_note, drive_status, created_at, included FROM record_files WHERE student_id = $1 ORDER BY created_at, id", [studentId])).rows;
  return rows.map(f => ({ id: f.id, activity: f.activity, course: f.course, name: f.file_name, mime: f.mime_type, size: f.byte_size, revision: f.revision, extractionStatus: f.extraction_status, text: f.extracted_text, extractionNote: f.extraction_note, driveStatus: f.drive_status, createdAt: iso(f.created_at)!, included: f.included }));
}

export async function recordDraft(db: RecordDb, actor: RecordActor, studentId: string): Promise<RecordDraft> {
  await assertRecordActor(db, actor, true);
  await assertRecordStudent(db, actor, studentId);
  const row = (await db.query<{ revision: number; source_revision: number; course1: string; course2: string; notes: string; checked_groups: string[]; evidence: RecordDraft["evidence"]; ai_result: RecordDraft["ai"]; status: string }>("SELECT * FROM record_drafts WHERE student_id = $1", [studentId])).rows[0];
  if (row) {
    try { await assertRecordEvidenceAccess(db, actor, studentId, row.evidence ? parseValue(row.evidence) : null); }
    catch (error) {
      if (!(error instanceof RecordEvidenceUnavailable)) throw error;
      // Retain the revision as an optimistic concurrency token only. No old
      // prose, notes, AI, source IDs or historical metadata enters the response.
      return { revision: row.revision, course1: "", course2: "", notes: "", checkedGroups: [], evidence: null, ai: null, status: "draft", sourceRevision: 0, previousDraftHidden: true };
    }
  }
  return { revision: row?.revision ?? 0, course1: row?.course1 ?? "", course2: row?.course2 ?? "", notes: row?.notes ?? "", checkedGroups: parseValue(row?.checked_groups ?? []), evidence: row?.evidence ? parseValue(row.evidence) : null, ai: row?.ai_result ? parseValue(row.ai_result) : null, status: row?.status ?? "draft", sourceRevision: row?.source_revision ?? 0 };
}

export async function getRecordWorkspace(actor: RecordActor, studentId: string): Promise<RecordWorkspace> {
  const db = await getDb();
  const student = await assertRecordStudent(db, actor, studentId);
  const submission = await recordSubmission(db, studentId);
  const files = await recordFiles(db, studentId);
  const settings = await recordSettings(db, student.teacher_id);
  const result: RecordWorkspace = { student: { id: student.id, name: student.name, loginId: student.login_id, classNumber: student.class_number, status: student.status, submissionStatus: submission.status, draftStatus: "draft" }, submission, files, settings };
  if (actor.role === "teacher") {
    result.draft = await recordDraft(db, actor, studentId);
    result.evidence = await collectRecordEvidence(db, actor, studentId);
    result.student.draftStatus = result.draft.status;
  } else {
    result.files = files.filter(file => file.included);
    result.settings = { ...settings, style: "", spreadsheetId: "", folderId: "" };
  }
  // Authority can change while assembling a large evidence bundle.
  await assertRecordStudent(db, actor, studentId);
  if (result.draft?.evidence) await assertRecordEvidenceAccess(db, actor, studentId, result.draft.evidence);
  if (result.evidence) await assertRecordEvidenceAccess(db, actor, studentId, result.evidence);
  return result;
}

export async function saveRecordSubmission(actor: RecordActor, studentId: string, value: unknown) {
  const input = submissionSchema.parse(value);
  if (actor.role !== "student") throw new RecordError("활동 선택과 제출은 학생 본인이 합니다.", 403);
  return recordTransaction(actor, studentId, async db => {
    await assertRecordWritable(db, actor, studentId);
    const previous = await recordSubmission(db, studentId);
    if (previous.revision !== input.expectedRevision) throw new FormWriteConflict();
    const revision = previous.revision + 1;
    await db.query("UPDATE record_submissions SET revision = $2, selected = $3, comments = $4, status = $5, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1", [studentId, revision, JSON.stringify(input.selected), JSON.stringify(input.comments), input.submit ? "submitted" : "draft"]);
    if (input.submit) {
      const snapshot = { ...(await recordSubmission(db, studentId)), files: await recordFiles(db, studentId) };
      await db.query("INSERT INTO record_submission_versions (id, student_id, revision, snapshot, created_by) VALUES ($1,$2,$3,$4,$5)", [createId("record_submission"), studentId, revision, JSON.stringify(snapshot), actor.id]);
    }
    return { revision };
  });
}

export async function saveRecordDraft(actor: RecordActor, studentId: string, value: unknown) {
  if (actor.role !== "teacher") throw new RecordError("교사만 세특을 작성할 수 있습니다.", 403);
  const input = draftSchema.parse(value);
  return recordTransaction(actor, studentId, async db => {
    const submission = await recordSubmission(db, studentId);
    const old = await recordDraft(db, actor, studentId);
    const evidence = await collectRecordEvidence(db, actor, studentId);
    if (old.revision !== input.expectedRevision || submission.revision !== input.expectedSubmissionRevision || evidence.hash !== input.expectedEvidenceHash) throw new FormWriteConflict("자료 또는 교사 작성본이 바뀌었습니다. 현재 입력을 보관한 뒤 최신 자료를 다시 확인해 주세요.");
    if (input.finalize && (!input.course1.trim() || !input.course2.trim())) throw new RecordError("두 과목의 세특을 모두 확인한 뒤 확정해 주세요.");
    if (input.finalize && evidence.missing.length && !input.notes.trim()) throw new RecordError("부족한 자료가 있습니다. 확인한 사유를 교사 메모에 남긴 뒤 확정해 주세요.");
    // A stale editor must not silently carry formerly visible prose into the
    // fresh branch. Only the blank workspace explicitly opts into this path.
    if (Boolean(input.startNewDraft) !== Boolean(old.previousDraftHidden)) throw new FormWriteConflict("이전 작성본의 접근 범위가 변경되었습니다. 최신 자료를 다시 열어 새 작성본을 시작해 주세요.");
    let revision = old.revision + 1;
    if (old.previousDraftHidden) {
      const preserved = (await db.query("SELECT * FROM record_drafts WHERE student_id = $1", [studentId])).rows[0];
      // Keep existing versions byte-for-byte. A separate version additionally
      // preserves the entire current row (including AI and original author).
      const snapshot = { course1: preserved.course1, course2: preserved.course2, notes: preserved.notes, status: preserved.status,
        evidence: preserved.evidence ? parseValue(preserved.evidence) : null, preservedDraft: preserved, archivedFromRevision: preserved.revision };
      await db.query("INSERT INTO record_draft_versions (id, student_id, revision, snapshot, created_by) VALUES ($1,$2,$3,$4,$5)",
        [createId("record_draft_archive"), studentId, revision, JSON.stringify(snapshot), preserved.teacher_id]);
      revision++;
    }
    const status = input.finalize ? "final" : "draft";
    const settings = await recordSettings(db, actor.id);
    const snapshot = { ...input, revision, status, evidence, settings };
    await db.query(`INSERT INTO record_drafts (student_id, teacher_id, revision, source_revision, course1, course2, notes, checked_groups, evidence, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (student_id) DO UPDATE SET teacher_id = EXCLUDED.teacher_id, revision = EXCLUDED.revision,
      source_revision = EXCLUDED.source_revision, course1 = EXCLUDED.course1, course2 = EXCLUDED.course2,
      notes = EXCLUDED.notes, checked_groups = EXCLUDED.checked_groups, evidence = EXCLUDED.evidence,
      status = EXCLUDED.status, ai_result = NULL, updated_at = CURRENT_TIMESTAMP`, [studentId, actor.id, revision, submission.revision, input.course1, input.course2, input.notes, JSON.stringify(input.checkedGroups), JSON.stringify(evidence), status]);
    await db.query("INSERT INTO record_draft_versions (id, student_id, revision, snapshot, created_by) VALUES ($1,$2,$3,$4,$5)", [createId("record_draft"), studentId, revision, JSON.stringify(snapshot), actor.id]);
    return { revision, status };
  });
}

export async function returnRecordSubmission(actor: RecordActor, studentId: string, value: unknown) {
  if (actor.role !== "teacher") throw new RecordError("담당 교사만 제출을 돌려줄 수 있습니다.", 403);
  const input = z.object({ expectedRevision: z.number().int().nonnegative(), note: z.string().trim().min(1).max(1000), reopenedUntil: z.iso.datetime() }).parse(value);
  if (new Date(input.reopenedUntil).getTime() <= Date.now()) throw new RecordError("수정 가능 기한은 현재 이후로 설정해 주세요.");
  return recordTransaction(actor, studentId, async db => {
    const previous = await recordSubmission(db, studentId);
    if (previous.revision !== input.expectedRevision) throw new FormWriteConflict();
    await db.query("UPDATE record_submissions SET revision = revision + 1, status = 'returned', returned_note = $2, reopened_until = $3, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1", [studentId, input.note, input.reopenedUntil]);
    return { revision: previous.revision + 1 };
  });
}

export async function saveRecordSettings(actor: RecordActor, value: unknown) {
  const input = z.object({ expectedRevision: z.number().int().nonnegative(), style: z.string().max(12000), opensAt: z.iso.datetime().nullable(), deadlineAt: z.iso.datetime().nullable() }).parse(value);
  if (input.opensAt && input.deadlineAt && input.opensAt >= input.deadlineAt) throw new RecordError("마감일은 시작일 이후로 설정해 주세요.");
  const client = await (await getDb()).connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [actor.id]);
    await assertRecordActor(client, actor, true);
    await client.query("INSERT INTO record_teacher_settings (teacher_id) VALUES ($1) ON CONFLICT (teacher_id) DO NOTHING", [actor.id]);
    const result = await client.query(`UPDATE record_teacher_settings SET style = $2, opens_at = $3, deadline_at = $4, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE teacher_id = $1 AND revision = $5 RETURNING revision`, [actor.id, input.style, input.opensAt, input.deadlineAt, input.expectedRevision]);
    if (!result.rows[0]) throw new FormWriteConflict();
    await client.query("COMMIT");
    return result.rows[0] as { revision: number };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function recordHistory(actor: RecordActor, studentId: string) {
  const db = await getDb();
  await assertRecordActor(db, actor, true);
  await assertRecordStudent(db, actor, studentId);
  const submissions = (await db.query("SELECT revision, snapshot, created_at FROM record_submission_versions WHERE student_id = $1 ORDER BY revision DESC", [studentId])).rows;
  const drafts = (await db.query("SELECT revision, snapshot, created_at FROM record_draft_versions WHERE student_id = $1 ORDER BY revision DESC", [studentId])).rows;
  const visibleDrafts = [];
  for (const draft of drafts) {
    const snapshot = parseValue<{ evidence?: unknown } | null>(draft.snapshot);
    try { await assertRecordEvidenceAccess(db, actor, studentId, snapshot?.evidence); }
    catch (error) {
      if (error instanceof RecordEvidenceUnavailable) continue;
      throw error;
    }
    visibleDrafts.push(draft);
  }
  await assertRecordStudent(db, actor, studentId);
  return { submissions, drafts: visibleDrafts };
}
