import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assertActiveTeamMember } from "@/lib/inquiry-data";
import { sendTeamMessage, userFacingAiError } from "@/lib/ai";
import { getDb } from "@/lib/db";

const schema = z.object({ sessionId: z.string(), content: z.string().trim().min(1).max(4000) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "student" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "질문을 입력해 주세요." }, { status: 400 });
  try {
    const teamId = await assertActiveTeamMember(user.id, parsed.data.sessionId);
    const db = await getDb();
    const members = await db.query<{ id: string }>(
      `SELECT u.id FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1 AND tm.status = 'active' ORDER BY tm.joined_at, u.login_id`,
      [teamId],
    );
    const index = members.rows.findIndex((member) => member.id === user.id);
    const alias = `팀원 ${String.fromCharCode(65 + Math.max(0, index))}`;
    const result = await sendTeamMessage(parsed.data.sessionId, teamId, { id: user.id, alias }, parsed.data.content);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ message: userFacingAiError(error) }, { status: 503 });
  }
}
