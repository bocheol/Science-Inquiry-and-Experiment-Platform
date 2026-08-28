import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { reviewReport } from "@/lib/report-service";
import { restoreReportRevision } from "@/lib/document-history";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("review"),
    reportId: z.string().trim().min(1).max(200),
    decision: z.enum(["reviewed", "feedback"]),
    feedback: z.string().max(10_000).default(""),
  }),
  z.object({ action: z.literal("restore"), reportId: z.string().trim().min(1).max(200), revisionId: z.string().trim().min(1).max(200) }),
]);

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "검토 요청을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "restore") await restoreReportRevision(parsed.data.reportId, parsed.data.revisionId, user.id);
    else await reviewReport(parsed.data.reportId, user.id, parsed.data.decision, parsed.data.feedback);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "검토 결과를 저장하지 못했습니다." }, { status: 400 });
  }
}
