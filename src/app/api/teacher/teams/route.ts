import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { assignStudent, createTeam, removeStudent, setTeamLeader } from "@/lib/teams";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), classNumber: z.number().int().min(1).max(9), teamNumber: z.number().int().min(1).max(20) }),
  z.object({ action: z.literal("assign"), studentId: z.string(), teamId: z.string(), asLeader: z.boolean().optional() }),
  z.object({ action: z.literal("remove"), studentId: z.string(), teamId: z.string() }),
  z.object({ action: z.literal("leader"), studentId: z.string(), teamId: z.string() }),
]);

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher") return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "요청 내용을 확인해 주세요." }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "create") await createTeam(user.id, input.classNumber, input.teamNumber);
    if (input.action === "assign") await assignStudent(user.id, input.studentId, input.teamId, input.asLeader);
    if (input.action === "remove") await removeStudent(user.id, input.studentId, input.teamId);
    if (input.action === "leader") await setTeamLeader(user.id, input.teamId, input.studentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "팀을 변경하지 못했습니다." }, { status: 400 });
  }
}

