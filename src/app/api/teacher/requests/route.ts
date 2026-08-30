import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  createTeacherRequest,
  listTeacherRequests,
  TEACHER_REQUEST_CATEGORIES,
  TEACHER_REQUEST_STATUSES,
  updateTeacherRequestStatus,
} from "@/lib/teacher-requests";

const createSchema = z.object({
  category: z.enum(TEACHER_REQUEST_CATEGORIES),
  title: z.string().trim().min(2).max(100),
  content: z.string().trim().min(5).max(3000),
});

const updateSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(TEACHER_REQUEST_STATUSES),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  return NextResponse.json({ requests: await listTeacherRequests(user) });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "분류·제목·내용을 확인해 주세요." }, { status: 400 });
  try {
    const id = await createTeacherRequest(user, parsed.data);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "건의·문의를 등록하지 못했습니다." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) {
    return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  }
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "처리 상태를 확인해 주세요." }, { status: 400 });
  try {
    await updateTeacherRequestStatus(user, parsed.data.requestId, parsed.data.status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "처리 상태를 변경하지 못했습니다." }, { status: 400 });
  }
}
