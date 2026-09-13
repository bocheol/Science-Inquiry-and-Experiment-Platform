import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { userFacingAiError } from "@/lib/ai";
import { requestTeacherPlanAiReview } from "@/lib/plan-ai-review";

const schema = z.object({ planId: z.string().min(1).max(200) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "검토할 계획서를 확인해 주세요." }, { status: 400 });
  try {
    return NextResponse.json({ review: await requestTeacherPlanAiReview(parsed.data.planId, user.id) });
  } catch (error) {
    return NextResponse.json({ message: userFacingAiError(error) }, { status: 400 });
  }
}
