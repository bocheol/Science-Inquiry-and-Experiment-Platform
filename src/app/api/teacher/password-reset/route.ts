import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, updatePassword } from "@/lib/auth";
import { audit, getDb } from "@/lib/db";
import { generateTemporaryPassword } from "@/lib/passwords";

const schema = z.object({ studentId: z.string().min(1) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== "teacher" || user.mustChangePassword) return NextResponse.json({ message: "권한이 없습니다." }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "학생을 확인해 주세요." }, { status: 400 });
  const db = await getDb();
  const student = await db.query<{ name: string; login_id: string }>(
    "SELECT name, login_id FROM users WHERE id = $1 AND role = 'student'",
    [parsed.data.studentId],
  );
  if (!student.rows[0]) return NextResponse.json({ message: "학생을 찾을 수 없습니다." }, { status: 404 });
  const temporaryPassword = generateTemporaryPassword();
  await updatePassword(parsed.data.studentId, temporaryPassword, true);
  await audit(user.id, "password_reset", "user", parsed.data.studentId);
  return NextResponse.json({
    ok: true,
    credential: { name: student.rows[0].name, loginId: student.rows[0].login_id, temporaryPassword },
  });
}
