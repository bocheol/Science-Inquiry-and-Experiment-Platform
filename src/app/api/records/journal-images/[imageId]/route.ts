import { getDb } from "@/lib/db";
import { recordsActor, recordApiError } from "@/lib/student-records/api";
import { assertRecordJournal, RecordError } from "@/lib/student-records/access";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ imageId: string }> }) {
  try {
    const user = await recordsActor(request, false);
    const db = await getDb();
    const { imageId } = await context.params;
    const owner = (await db.query<{ student_id: string; journal_id: string }>("SELECT j.student_id, j.id AS journal_id FROM experiment_journal_images i JOIN experiment_journals j ON j.id = i.journal_id WHERE i.id = $1", [imageId])).rows[0];
    if (!owner) throw new RecordError("사진을 찾을 수 없습니다.", 404);
    await assertRecordJournal(db, user, owner.student_id, owner.journal_id);
    const image = (await db.query<{ image_data: Buffer; file_name: string }>("SELECT image_data, file_name FROM experiment_journal_images WHERE id = $1", [imageId])).rows[0];
    if (!image) throw new RecordError("사진을 찾을 수 없습니다.", 404);
    await assertRecordJournal(db, user, owner.student_id, owner.journal_id);
    return new Response(new Uint8Array(image.image_data), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(image.file_name), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } });
  } catch (error) { return recordApiError(error); }
}
