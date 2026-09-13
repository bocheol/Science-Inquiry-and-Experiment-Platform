import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/request-body";
import { authenticateForSession, createSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  clearLoginAttempts,
  clientNetworkIdentifier,
  getLoginAttemptState,
  loginAttemptBucketKey,
  recordFailedLogin,
} from "@/lib/login-attempts";

const inputSchema = z.object({
  loginId: z.string().trim().min(1).max(30),
  password: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ message: "아이디와 비밀번호를 확인해 주세요." }, { status: 400 });
  const bucketKey = loginAttemptBucketKey(parsed.data.loginId, clientNetworkIdentifier(request));
  const currentAttempt = await getLoginAttemptState(bucketKey);
  if (currentAttempt.blocked) {
    return NextResponse.json(
      { message: "로그인 시도가 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(currentAttempt.retryAfterSeconds) } },
    );
  }
  const authenticated = await authenticateForSession(parsed.data.loginId, parsed.data.password);
  if (!authenticated) {
    const failedAttempt = await recordFailedLogin(bucketKey);
    if (failedAttempt.blocked) {
      return NextResponse.json(
        { message: "로그인 시도가 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요." },
        { status: 429, headers: { "Retry-After": String(failedAttempt.retryAfterSeconds) } },
      );
    }
    return NextResponse.json({ message: "아이디 또는 비밀번호가 맞지 않습니다." }, { status: 401 });
  }
  await clearLoginAttempts(bucketKey);
  await createSession(authenticated);
  const db = await getDb();
  const { rows } = await db.query<{ role: string; must_change_password: boolean }>(
    "SELECT role, must_change_password FROM users WHERE id = $1",
    [authenticated.userId],
  );
  const user = rows[0];
  return NextResponse.json({
    ok: true,
    destination: user.must_change_password ? "/change-password" : user.role === "teacher" ? "/teacher" : "/inquiry",
  });
}
