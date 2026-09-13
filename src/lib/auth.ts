import { compare, hash } from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { ACADEMIC_YEAR, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/constants";
import { getDb } from "@/lib/db";
import type { Role, SessionUser } from "@/lib/types";

function getSessionKey() {
  const configured = process.env.SESSION_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("운영 환경에는 SESSION_SECRET이 필요합니다.");
  }
  const value = configured ?? "local-development-only-science-inquiry-session";
  return createHash("sha256").update(value).digest();
}

export type AuthenticatedSession = {
  userId: string;
  sessionVersion: number;
};

export async function authenticateForSession(loginId: string, password: string, academicYear = ACADEMIC_YEAR): Promise<AuthenticatedSession | null> {
  const db = await getDb();
  const { rows } = await db.query<{
    id: string;
    password_hash: string;
    status: string;
    session_version: number;
  }>(
    `SELECT id, password_hash, status, session_version FROM users
     WHERE academic_year = $1 AND login_id = $2`,
    [academicYear, loginId.trim()],
  );
  const record = rows[0];
  if (!record || record.status !== "active" || !(await compare(password, record.password_hash))) {
    return null;
  }
  return { userId: record.id, sessionVersion: record.session_version };
}

export async function authenticate(loginId: string, password: string, academicYear = ACADEMIC_YEAR) {
  return (await authenticateForSession(loginId, password, academicYear))?.userId ?? null;
}

export async function createSessionToken(session: AuthenticatedSession) {
  return new SignJWT({ userId: session.userId, sessionVersion: session.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionKey());
}

export async function createSession(session: AuthenticatedSession) {
  const token = await createSessionToken(session);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

async function sessionUserFromId(userId: string, sessionVersion: number): Promise<SessionUser | null> {
  const db = await getDb();
  const { rows } = await db.query<{
    id: string;
    name: string;
    login_id: string;
    role: Role;
    academic_year: number;
    class_id: string | null;
    class_number: number | null;
    must_change_password: boolean;
    account_type: "standard" | "demo";
    is_master: boolean;
  }>(
    `SELECT u.id, u.name, u.login_id, u.role, u.academic_year, u.class_id,
            c.class_number, u.must_change_password, u.account_type, u.is_master
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = $1 AND u.session_version = $2 AND u.status = 'active'
        AND u.academic_year = $3`,
    [userId, sessionVersion, ACADEMIC_YEAR],
  );
  const user = rows[0];
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    loginId: user.login_id,
    role: user.role,
    academicYear: user.academic_year,
    classId: user.class_id,
    classNumber: user.class_number,
    mustChangePassword: user.must_change_password,
    accountType: user.account_type,
    isMaster: user.is_master,
  };
}

export async function getSessionUserFromToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, getSessionKey());
    if (typeof payload.userId !== "string" || !Number.isInteger(payload.sessionVersion) || Number(payload.sessionVersion) < 1) return null;
    return sessionUserFromId(payload.userId, Number(payload.sessionVersion));
  } catch {
    return null;
  }
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionUserFromToken(token);
}

export async function requireUser(role?: Role) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (role && user.role !== role) redirect(user.role === "teacher" ? "/teacher" : "/inquiry");
  if (user.mustChangePassword) redirect("/change-password");
  return user;
}

export async function updatePassword(userId: string, newPassword: string, requireChange = false) {
  const db = await getDb();
  const result = await db.query<{ session_version: number }>(
    `UPDATE users
        SET password_hash = $1,
            must_change_password = $2,
            session_version = session_version + 1
      WHERE id = $3 AND academic_year = $4
      RETURNING session_version`,
    [await hash(newPassword, 12), requireChange, userId, ACADEMIC_YEAR],
  );
  if (!result.rows[0]) throw new Error("비밀번호를 변경할 계정을 찾을 수 없습니다.");
  return result.rows[0].session_version;
}
