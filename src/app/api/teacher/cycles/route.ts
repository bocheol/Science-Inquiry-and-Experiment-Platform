import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { updateCycleSettings } from "@/lib/cycle-settings";
import { requestCycleAnalysis } from "@/lib/cycle-analysis";
import { transitionCycle } from "@/lib/cycle-workflow";
import { userFacingAiError } from "@/lib/ai";
import { userFacingMessage } from "@/lib/user-facing-error";

const schema = z.object({
  cycleId: z.string().min(1).max(240),
  title: z.string().trim().min(1).max(60),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "회차 설정을 확인해 주세요." }, { status: 400 });
  try {
    await updateCycleSettings({ ...parsed.data, teacherId: user.id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: userFacingMessage(error, "회차 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("analyze"), cycleId: z.string().min(1).max(240), analysisType: z.enum(["intermediate", "final"]) }),
  z.object({ action: z.literal("start_next"), cycleId: z.string().min(1).max(240) }),
  z.object({ action: z.literal("finish_project"), cycleId: z.string().min(1).max(240) }),
]);

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  const parsed = actionSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "회차 작업을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "analyze") {
      return NextResponse.json({ analysis: await requestCycleAnalysis(parsed.data.cycleId, parsed.data.analysisType, user.id) });
    }
    return NextResponse.json({ result: await transitionCycle({
      cycleId: parsed.data.cycleId,
      action: parsed.data.action,
      teacherId: user.id,
    }) });
  } catch (error) {
    const message = parsed.data.action === "analyze"
      ? userFacingAiError(error)
      : userFacingMessage(error, "회차를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    return NextResponse.json({ message }, { status: 400 });
  }
}
