import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { listStudentNotices, markNoticeRead } from "@/lib/notices";

const readSchema = z.object({ noticeId: z.string().trim().min(1).max(200) });

async function requireStudent() {
  const user = await getCurrentUser();
  return user?.role === "student" && !user.mustChangePassword ? user : null;
}

export async function GET() {
  const user = await requireStudent();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  return NextResponse.json({ feed: await listStudentNotices(user) });
}

export async function PATCH(request: Request) {
  const user = await requireStudent();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = readSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "확인할 공지를 선택해 주세요." }, { status: 400 });
  try {
    await markNoticeRead(user, parsed.data.noticeId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "공지를 확인 처리하지 못했습니다." }, { status: 400 });
  }
}
