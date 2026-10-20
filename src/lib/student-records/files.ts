import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { FormWriteConflict } from "@/lib/form-write-conflict";
import { assertRecordActor, assertRecordStudent, assertRecordWritable, RecordError, recordTransaction, type RecordActor } from "./access";
import { activitySchema, RECORD_ACTIVITIES } from "./model";
import { detectRecordFile, extractRecordText, RECORD_TEXT_MAX_CHARS, type Extraction } from "./extraction";

export async function uploadRecordFile(actor: RecordActor, studentId: string, activityValue: unknown, name: string, data: Buffer) {
  const activity = activitySchema.parse(activityValue);
  const course = RECORD_ACTIVITIES.find(a => a.id === activity)!.course;
  const mime = detectRecordFile(name, data);
  const hash = createHash("sha256").update(data).digest("hex");
  const result = await recordTransaction(actor, studentId, async db => {
    await assertRecordWritable(db, actor, studentId);
    const previous = (await db.query<{ id: string; included: boolean }>("SELECT id, included FROM record_files WHERE student_id = $1 AND activity = $2 AND content_hash = $3", [studentId, activity, hash])).rows[0];
    if (previous && !previous.included && actor.role === "student") throw new RecordError("담당 교사가 제외한 자료입니다. 다시 활용하려면 선생님께 확인해 주세요.");
    if (previous) return { id: previous.id, duplicate: true };
    const budget = (await db.query<{ count: string; bytes: string }>("SELECT count(*) AS count, COALESCE(sum(byte_size), 0) AS bytes FROM record_files WHERE student_id = $1", [studentId])).rows[0];
    if (Number(budget.count) >= 40 || Number(budget.bytes) + data.length > 100 * 1024 * 1024) throw new RecordError("학생별 원본 보관 한도(40개·100MB)에 도달했습니다. 담당 교사에게 알려 주세요.");
    const id = createId("record_file");
    const fileName = name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 240);
    await db.query(`INSERT INTO record_files (id, student_id, uploaded_by, activity, course, file_name, mime_type, byte_size, content_hash, file_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, studentId, actor.id, activity, course, fileName, mime, data.length, hash, data]);
    await db.query("UPDATE record_submissions SET revision = revision + 1, status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE student_id = $1", [studentId]);
    return { id, duplicate: false };
  });
  return result;
}

export async function getRecordFile(actor: RecordActor, id: string) {
  const db = await getDb();
  const row = (await db.query<{ id: string; student_id: string; file_name: string; mime_type: string; file_data: Buffer; revision: number; extraction_status: string; extracted_text: string; content_hash: string; drive_file_id: string | null; drive_status: string; included: boolean }>("SELECT * FROM record_files WHERE id = $1", [id])).rows[0];
  if (!row) throw new RecordError("자료를 찾을 수 없습니다.", 404);
  await assertRecordStudent(db, actor, row.student_id);
  if (!row.included && actor.role === "student") throw new RecordError("현재 학생에게 공개된 자료가 아닙니다.", 403);
  return row;
}

export async function saveRecordExtraction(actor: RecordActor, fileId: string, expectedRevision: number, extraction: Extraction, confirm = false) {
  const file = await getRecordFile(actor, fileId);
  if (confirm && actor.role !== "teacher") throw new RecordError("추출 내용은 담당 교사가 확인합니다.", 403);
  if (extraction.text.length > RECORD_TEXT_MAX_CHARS) throw new RecordError("추출 본문은 10만 자까지 보관할 수 있습니다.");
  return recordTransaction(actor, file.student_id, async db => {
    // A parser retry doesn't change the student's authored submission. A teacher
    // correction/confirmation does change the evidence and invalidates old drafts.
    if (!confirm && actor.role === "student") await assertRecordWritable(db, actor, file.student_id);
    const updated = await db.query(`UPDATE record_files SET extracted_text = $2, extraction_status = $3, extraction_note = $4,
      revision = revision + 1, reviewed_by = $5 WHERE id = $1 AND revision = $6 RETURNING revision`,
    [fileId, extraction.text, confirm ? "ready" : extraction.status, extraction.note, confirm ? actor.id : null, expectedRevision]);
    if (!updated.rows[0]) throw new FormWriteConflict();
    await db.query("UPDATE record_submissions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1", [file.student_id]);
    return updated.rows[0] as { revision: number };
  });
}

export async function parseRecordFile(actor: RecordActor, id: string, expectedRevision: number) {
  const file = await getRecordFile(actor, id);
  if (file.revision !== expectedRevision) throw new FormWriteConflict();
  // Students cannot reset a teacher-verified source by rerunning extraction.
  if (file.extraction_status === "ready") throw new RecordError("교사가 확인한 본문입니다. 수정은 담당 교사가 직접 해 주세요.", 409);
  const extraction = await extractRecordText(Buffer.from(file.file_data), file.mime_type);
  return saveRecordExtraction(actor, id, expectedRevision, extraction);
}

export async function confirmRecordFile(actor: RecordActor, id: string, revision: number, text: string) {
  await assertRecordActor(await getDb(), actor, true);
  if (!text.trim()) throw new RecordError("원본과 비교한 본문을 입력해 주세요.");
  return saveRecordExtraction(actor, id, revision, { status: "review", text, note: "담당 교사가 원본과 추출 내용을 확인했습니다." }, true);
}

export async function setRecordFileIncluded(actor: RecordActor, id: string, revision: number, included: boolean) {
  await assertRecordActor(await getDb(), actor, true);
  const file = await getRecordFile(actor, id);
  return recordTransaction(actor, file.student_id, async db => {
    const changed = await db.query("UPDATE record_files SET included = $2, revision = revision + 1 WHERE id = $1 AND revision = $3 RETURNING revision", [id, included, revision]);
    if (!changed.rows[0]) throw new FormWriteConflict();
    await db.query("UPDATE record_submissions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE student_id = $1", [file.student_id]);
    return changed.rows[0] as { revision: number };
  });
}
