import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, createSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

const inputSchema = z.object({
  loginId: z.string().trim().min(1).max(30),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ message: "아이디와 비밀번호를 확인해 주세요." }, { status: 400 });
  const userId = await authenticate(parsed.data.loginId, parsed.data.password);
  if (!userId) return NextResponse.json({ message: "아이디 또는 비밀번호가 맞지 않습니다." }, { status: 401 });
  await createSession(userId);
  const db = await getDb();
  const { rows } = await db.query<{ role: string; must_change_password: boolean }>(
    "SELECT role, must_change_password FROM users WHERE id = $1",
    [userId],
  );
  const user = rows[0];
  return NextResponse.json({
    ok: true,
    destination: user.must_change_password ? "/change-password" : user.role === "teacher" ? "/teacher" : "/inquiry",
  });
}

