import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertStudentReportAccess, lockReportField, releaseReportField } from "@/lib/report-service";

const schema = z.object({ reportId: z.string().trim().min(1).max(200), fieldKey: z.string().trim().min(1).max(220), action: z.enum(["acquire", "release"]) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "잠금 요청을 확인해 주세요." }, { status: 400 });
  try {
    await assertStudentReportAccess(user.id, parsed.data.reportId);
    if (parsed.data.action === "acquire") await lockReportField(parsed.data.reportId, parsed.data.fieldKey, user);
    else await releaseReportField(parsed.data.reportId, parsed.data.fieldKey, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "작성 권한을 얻지 못했습니다." }, { status: 409 });
  }
}
