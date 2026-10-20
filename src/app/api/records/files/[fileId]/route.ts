import { recordsActor, recordApiError } from "@/lib/student-records/api";
import { getRecordFile } from "@/lib/student-records/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  try {
    const user = await recordsActor(request, false);
    const { fileId } = await context.params;
    const file = await getRecordFile(user, fileId);
    return new Response(new Uint8Array(file.file_data), { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.file_name),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    } });
  } catch (error) { return recordApiError(error); }
}
