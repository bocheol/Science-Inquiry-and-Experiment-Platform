import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertStudentReportAccess, saveReportField, saveReportMemberRole, submitReport } from "@/lib/report-service";
import { restoreReportRevision } from "@/lib/document-history";

const patchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), reportId: z.string().trim().min(1).max(200), fieldKey: z.string().trim().min(1).max(100), value: z.string().max(30_000) }),
  z.object({ kind: z.literal("role"), reportId: z.string().trim().min(1).max(200), userId: z.string().trim().min(1).max(200), value: z.string().max(2_000) }),
]);
const submitSchema = z.discriminatedUnion("action", [
  z.object({ reportId: z.string().trim().min(1).max(200), action: z.literal("submit") }),
  z.object({ reportId: z.string().trim().min(1).max(200), action: z.literal("restore"), revisionId: z.string().trim().min(1).max(200) }),
]);

function errorResponse(error: unknown, fallback: string, status = 400) {
  return NextResponse.json({ message: error instanceof Error ? error.message : fallback }, { status });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "저장할 내용을 확인해 주세요." }, { status: 400 });
  try {
    await assertStudentReportAccess(user.id, parsed.data.reportId);
    if (parsed.data.kind === "field") await saveReportField(parsed.data.reportId, parsed.data.fieldKey, parsed.data.value, user.id);
    else await saveReportMemberRole(parsed.data.reportId, parsed.data.userId, parsed.data.value, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "보고서를 저장하지 못했습니다.", 409);
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = submitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "제출 요청을 확인해 주세요." }, { status: 400 });
  try {
    await assertStudentReportAccess(user.id, parsed.data.reportId);
    if (parsed.data.action === "submit") await submitReport(parsed.data.reportId, user.id);
    else await restoreReportRevision(parsed.data.reportId, parsed.data.revisionId, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "보고서를 제출하지 못했습니다.");
  }
}
