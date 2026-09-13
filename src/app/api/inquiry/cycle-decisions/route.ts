import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { saveCycleDecision } from "@/lib/cycle-analysis";
import { userFacingMessage } from "@/lib/user-facing-error";
import { FormWriteConflict } from "@/lib/form-write-conflict";

const schema = z.object({
  analysisId: z.string().min(1).max(240),
  suggestionId: z.string().min(1).max(120),
  decision: z.enum(["accepted", "modified", "rejected"]),
  reason: z.string().trim().min(1).max(1200),
  expectedVersion: z.number().int().nonnegative().nullable(),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "AI 제안에 대한 선택과 이유를 확인해 주세요." }, { status: 400 });
  try {
    return NextResponse.json({ decision: await saveCycleDecision({ ...parsed.data, studentId: user.id }) });
  } catch (error) {
    return NextResponse.json(
      { message: userFacingMessage(error, "선택을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") },
      { status: error instanceof FormWriteConflict ? 409 : 400 },
    );
  }
}
