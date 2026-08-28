import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { JournalAccessError, listTeacherTeamJournals } from "@/lib/journal-service";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = z.string().trim().min(1).max(200).safeParse(new URL(request.url).searchParams.get("teamId"));
  if (!parsed.success) return NextResponse.json({ message: "팀을 확인해 주세요." }, { status: 400 });
  try {
    return NextResponse.json(await listTeacherTeamJournals(user, parsed.data));
  } catch (error) {
    const status = error instanceof JournalAccessError ? error.status : 400;
    return NextResponse.json({ message: error instanceof Error ? error.message : "실험 일지를 불러오지 못했습니다." }, { status });
  }
}
