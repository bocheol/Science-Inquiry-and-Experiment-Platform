import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { lockPlanField, releasePlanField } from "@/lib/plan-service";
import { userFacingMessage } from "@/lib/user-facing-error";

const schema = z.object({ cycleId: z.string().trim().min(1).max(200), planId: z.string(), fieldKey: z.string(), action: z.enum(["acquire", "release"]) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "잠금 요청을 확인해 주세요." }, { status: 400 });
  const db = await getDb();
  const plan = await db.query<{ session_id: string }>("SELECT session_id FROM investigation_plans WHERE id = $1", [parsed.data.planId]);
  if (!plan.rows[0]) return NextResponse.json({ message: "계획서를 찾을 수 없습니다." }, { status: 404 });
  try {
    await assertActiveTeamMember(user.id, plan.rows[0].session_id);
    if (parsed.data.action === "acquire") await lockPlanField(parsed.data.planId, parsed.data.fieldKey, user, parsed.data.cycleId);
    else await releasePlanField(parsed.data.planId, parsed.data.fieldKey, user.id, parsed.data.cycleId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: userFacingMessage(error, "작성 권한을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 409 });
  }
}
