import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { createSession, getCurrentUser, updatePassword } from "@/lib/auth";
import { audit } from "@/lib/db";
import { isAcceptablePassword } from "@/lib/passwords";

const inputSchema = z.object({ newPassword: z.string().max(200) });

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ message: "다시 로그인해 주세요." }, { status: 401 });
  const parsed = inputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success || !isAcceptablePassword(parsed.data.newPassword)) {
    return NextResponse.json({ message: "8자 이상이며 글자와 숫자를 포함해야 합니다." }, { status: 400 });
  }
  const sessionVersion = await updatePassword(user.id, parsed.data.newPassword, false);
  await createSession({ userId: user.id, sessionVersion });
  await audit(user.id, "password_changed", "user", user.id);
  return NextResponse.json({ ok: true, destination: user.role === "teacher" ? "/teacher" : "/inquiry" });
}
