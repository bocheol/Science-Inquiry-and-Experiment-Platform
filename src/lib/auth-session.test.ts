import { hash } from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  authenticateForSession,
  createSessionToken,
  getSessionUserFromToken,
  updatePassword,
} from "@/lib/auth";
import { getDb } from "@/lib/db";

describe("versioned login sessions", () => {
  it("invalidates every older token after a password change while a new token remains usable", async () => {
    const db = await getDb();
    const userId = "auth_session_version_student";
    const oldPassword = "old-password-123";
    const newPassword = "new-password-456";
    await db.query(
      `INSERT INTO users
        (id, name, login_id, academic_year, role, password_hash, must_change_password)
       VALUES ($1, '세션검증학생', 'session-version-student', 2026, 'student', $2, FALSE)`,
      [userId, await hash(oldPassword, 4)],
    );

    const oldAuthentication = await authenticateForSession("session-version-student", oldPassword);
    expect(oldAuthentication).toMatchObject({ userId, sessionVersion: 1 });
    const oldToken = await createSessionToken(oldAuthentication!);
    expect((await getSessionUserFromToken(oldToken))?.id).toBe(userId);

    const newVersion = await updatePassword(userId, newPassword);
    expect(newVersion).toBe(2);
    await expect(getSessionUserFromToken(oldToken)).resolves.toBeNull();
    await expect(authenticateForSession("session-version-student", oldPassword)).resolves.toBeNull();

    const newAuthentication = await authenticateForSession("session-version-student", newPassword);
    const newToken = await createSessionToken(newAuthentication!);
    expect((await getSessionUserFromToken(newToken))?.id).toBe(userId);
  });
});
