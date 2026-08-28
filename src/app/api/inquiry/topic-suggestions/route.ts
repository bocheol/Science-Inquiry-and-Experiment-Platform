import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { generateTopicSuggestions, userFacingAiError } from "@/lib/ai";

const schema = z.object({ sessionId: z.string(), interest: z.string().trim().min(2).max(1200) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "관심사를 두 글자 이상 적어 주세요." }, { status: 400 });
  try {
    const teamId = await assertActiveTeamMember(user.id, parsed.data.sessionId);
    const result = await generateTopicSuggestions(parsed.data.sessionId, teamId, parsed.data.interest, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ message: userFacingAiError(error) }, { status: 503 });
  }
}
