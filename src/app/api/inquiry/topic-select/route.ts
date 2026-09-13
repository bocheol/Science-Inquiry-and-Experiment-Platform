import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { getCurrentUser } from "@/lib/auth";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { selectTopic } from "@/lib/plan-service";
import { userFacingMessage } from "@/lib/user-facing-error";

const schema = z.object({ cycleId: z.string().trim().min(1).max(200), sessionId: z.string(), planId: z.string(), topic: z.string().trim().min(2).max(500), expectedTopic: z.string().max(30000).optional() });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "탐구 주제를 확인해 주세요." }, { status: 400 });
  try {
    await assertActiveTeamMember(user.id, parsed.data.sessionId);
    await selectTopic(parsed.data.sessionId, parsed.data.planId, parsed.data.topic, user.id, parsed.data.expectedTopic, parsed.data.cycleId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: userFacingMessage(error, "주제를 선택하지 못했습니다. 잠시 후 다시 시도해 주세요.") }, { status: 400 });
  }
}
