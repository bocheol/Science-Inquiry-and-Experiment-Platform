import { NextResponse } from "next/server";
import { z } from "zod";
import { readFormDataBody } from "@/lib/request-form-data";
import { readJsonBody } from "@/lib/request-body";
import { recordsActor, recordApiError } from "@/lib/student-records/api";
import { RecordError } from "@/lib/student-records/access";
import { confirmRecordFile, parseRecordFile, setRecordFileIncluded, uploadRecordFile } from "@/lib/student-records/files";
import { ocrRecordFile } from "@/lib/student-records/ai";
import { syncRecordFileToDrive } from "@/lib/student-records/google";
import { RECORD_FILE_MAX_BYTES } from "@/lib/student-records/extraction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await recordsActor(request);
    const parsed = await readFormDataBody(request, RECORD_FILE_MAX_BYTES + 64 * 1024);
    if (parsed.kind !== "ok") throw new RecordError("파일은 한 개당 10MB 이하로 올려 주세요.", parsed.kind === "too-large" ? 413 : 400);
    const form = parsed.data;
    const file = form.get("file");
    if (!(file instanceof File)) throw new RecordError("업로드할 파일을 선택해 주세요.");
    const studentId = z.string().min(1).max(200).parse(form.get("studentId") || user.id);
    const result = await uploadRecordFile(user, studentId, form.get("activity"), file.name, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(result);
  } catch (error) { return recordApiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const user = await recordsActor(request);
    const input = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive(), action: z.enum(["parse", "confirm", "ocr", "sync", "include", "exclude"]), text: z.string().max(100_000).optional() }).parse(await readJsonBody(request, 500_000));
    if (input.action === "parse") return NextResponse.json(await parseRecordFile(user, input.id, input.revision));
    if (input.action === "confirm") return NextResponse.json(await confirmRecordFile(user, input.id, input.revision, input.text ?? ""));
    if (input.action === "ocr") return NextResponse.json(await ocrRecordFile(user, input.id, input.revision));
    if (input.action === "include" || input.action === "exclude") return NextResponse.json(await setRecordFileIncluded(user, input.id, input.revision, input.action === "include"));
    return NextResponse.json(await syncRecordFileToDrive(user, input.id));
  } catch (error) { return recordApiError(error); }
}
