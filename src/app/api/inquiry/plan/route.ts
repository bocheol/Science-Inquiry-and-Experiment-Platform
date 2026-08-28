import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { savePlanField, submitPlan } from "@/lib/plan-service";
import { getDb } from "@/lib/db";
import { restorePlanRevision } from "@/lib/document-history";

const patchSchema = z.object({ planId: z.string(), fieldKey: z.string(), value: z.unknown() });
const submitSchema = z.discriminatedUnion("action", [
  z.object({ planId: z.string().min(1).max(200), action: z.literal("submit") }),
  z.object({ planId: z.string().min(1).max(200), action: z.literal("restore"), revisionId: z.string().min(1).max(200) }),
]);

async function authorizePlan(userId: string, planId: string) {
  const db = await getDb();
  const result = await db.query<{ session_id: string }>("SELECT session_id FROM investigation_plans WHERE id = $1", [planId]);
  if (!result.rows[0]) throw new Error("계획서를 찾을 수 없습니다.");
  await assertActiveTeamMember(userId, result.rows[0].session_id);
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "저장할 내용을 확인해 주세요." }, { status: 400 });
  try {
    await authorizePlan(user.id, parsed.data.planId);
    await savePlanField(parsed.data.planId, parsed.data.fieldKey, parsed.data.value, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "저장하지 못했습니다." }, { status: 409 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = submitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "제출 요청을 확인해 주세요." }, { status: 400 });
  try {
    await authorizePlan(user.id, parsed.data.planId);
    if (parsed.data.action === "submit") await submitPlan(parsed.data.planId, user.id);
    else await restorePlanRevision(parsed.data.planId, parsed.data.revisionId, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "제출하지 못했습니다." }, { status: 400 });
  }
}
