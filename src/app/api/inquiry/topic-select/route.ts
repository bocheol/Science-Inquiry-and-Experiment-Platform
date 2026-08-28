import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { selectTopic } from "@/lib/ai";

const schema = z.object({ sessionId: z.string(), planId: z.string(), topic: z.string().trim().min(2).max(500) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "탐구 주제를 확인해 주세요." }, { status: 400 });
  try {
    await assertActiveTeamMember(user.id, parsed.data.sessionId);
    await selectTopic(parsed.data.sessionId, parsed.data.planId, parsed.data.topic, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "주제를 선택하지 못했습니다." }, { status: 400 });
  }
}

