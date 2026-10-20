import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { readJsonBody } from "@/lib/request-body";
import { recordsActor, recordApiError } from "@/lib/student-records/api";
import { assertRecordActor, RecordError, recordSettings, teacherRecordStudents } from "@/lib/student-records/access";
import { getRecordWorkspace, recordHistory, returnRecordSubmission, saveRecordDraft, saveRecordSettings, saveRecordSubmission } from "@/lib/student-records/service";
import { generateRecordDraft } from "@/lib/student-records/ai";
import { exportTeacherRecords, importRecordGoogleDoc, recordsGoogleConfigured } from "@/lib/student-records/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await recordsActor(request);
    await assertRecordActor(await getDb(), user);
    const query = new URL(request.url).searchParams;
    if (query.has("identity")) return NextResponse.json({ id: user.id });
    const studentId = query.get("studentId") || (user.role === "student" ? user.id : null);
    if (query.has("history") && studentId) return NextResponse.json(await recordHistory(user, studentId));
    if (studentId) return NextResponse.json(await getRecordWorkspace(user, studentId));
    return NextResponse.json({ students: await teacherRecordStudents(user), settings: await recordSettings(await getDb(), user.id), googleConfigured: recordsGoogleConfigured() });
  } catch (error) { return recordApiError(error); }
}
export async function POST(request: Request) {
  try {
    const user = await recordsActor(request);
    const body = z.object({ action: z.enum(["submission", "draft", "return", "settings", "generate", "export", "import-doc"]), studentId: z.string().min(1).max(200).optional(), data: z.unknown() }).parse(await readJsonBody(request, 500_000));
    const studentId = body.studentId ?? user.id;
    if (body.action === "submission") return NextResponse.json(await saveRecordSubmission(user, studentId, body.data));
    if (body.action === "draft") return NextResponse.json(await saveRecordDraft(user, studentId, body.data));
    if (body.action === "return") return NextResponse.json(await returnRecordSubmission(user, studentId, body.data));
    if (body.action === "settings") return NextResponse.json(await saveRecordSettings(user, body.data));
    if (body.action === "generate") {
      const data = z.object({ evidenceHash: z.string().length(64) }).parse(body.data);
      return NextResponse.json(await generateRecordDraft(user, studentId, data.evidenceHash));
    }
    if (body.action === "export") return NextResponse.json(await exportTeacherRecords(user, z.object({ requestId: z.string() }).parse(body.data).requestId));
    if (body.action === "import-doc") {
      const data = z.object({ url: z.string().max(1000), activity: z.string() }).parse(body.data);
      return NextResponse.json(await importRecordGoogleDoc(user, studentId, data.activity, data.url));
    }
    throw new RecordError("지원하지 않는 요청입니다.");
  } catch (error) { return recordApiError(error); }
}
