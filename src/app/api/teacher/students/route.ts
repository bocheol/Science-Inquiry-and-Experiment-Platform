import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { addStudent, deactivateStudent, restoreStudent } from "@/lib/student-management";

const addSchema = z.object({
  loginId: z.string().trim().length(5),
  name: z.string().trim().min(1).max(80),
});

const statusSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deactivate"), studentId: z.string().min(1).max(200) }),
  z.object({ action: z.literal("restore"), studentId: z.string().min(1).max(200) }),
]);

async function requireTeacher() {
  const user = await getCurrentUser();
  return user?.role === "teacher" && !user.mustChangePassword ? user : null;
}

export async function POST(request: Request) {
  const user = await requireTeacher();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "학생의 5자리 학번과 이름을 확인해 주세요." }, { status: 400 });
  try {
    const credential = await addStudent(user.id, parsed.data);
    return NextResponse.json({ ok: true, credential });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "학생을 추가하지 못했습니다." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const user = await requireTeacher();
  if (!user) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = statusSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "학생 계정 변경 요청을 확인해 주세요." }, { status: 400 });
  try {
    if (parsed.data.action === "deactivate") await deactivateStudent(user.id, parsed.data.studentId);
    else await restoreStudent(user.id, parsed.data.studentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "학생 계정을 변경하지 못했습니다." }, { status: 400 });
  }
}
