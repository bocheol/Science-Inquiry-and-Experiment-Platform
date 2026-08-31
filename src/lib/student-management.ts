import { hash } from "bcryptjs";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { generateTemporaryPassword } from "@/lib/passwords";
import type { IssuedCredential } from "@/lib/roster";

export function parseStudentLoginId(loginId: string) {
  const normalized = loginId.trim();
  const match = /^1(0[1-9])(0[1-9]|[1-9][0-9])$/.exec(normalized);
  if (!match) throw new Error("학번은 1학년·1~9반·1~99번에 맞는 5자리로 입력해 주세요.");
  return {
    loginId: normalized,
    classNumber: Number(match[1]),
    studentNumber: Number(match[2]),
  };
}

export async function addStudent(
  actorId: string,
  input: { loginId: string; name: string },
): Promise<IssuedCredential> {
  const parsed = parseStudentLoginId(input.loginId);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error("학생 이름을 1자 이상 80자 이하로 입력해 주세요.");

  const db = await getDb();
  const existing = await db.query<{ status: string }>(
    "SELECT status FROM users WHERE academic_year = $1 AND login_id = $2",
    [ACADEMIC_YEAR, parsed.loginId],
  );
  if (existing.rows[0]?.status === "inactive") {
    throw new Error("비활성 학생 목록에 같은 학번이 있습니다. 해당 계정을 복원해 주세요.");
  }
  if (existing.rows[0]) throw new Error("이미 등록된 학번입니다.");

  const classId = `class_${ACADEMIC_YEAR}_${parsed.classNumber}`;
  const classRow = await db.query("SELECT id FROM classes WHERE id = $1", [classId]);
  if (!classRow.rows[0]) throw new Error("학급을 찾을 수 없습니다.");

  const temporaryPassword = generateTemporaryPassword();
  const studentId = createId("user");
  await db.query(
    `INSERT INTO users
      (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password, status)
     VALUES ($1, $2, $3, $4, 'student', $5, $6, TRUE, 'active')`,
    [studentId, name, parsed.loginId, ACADEMIC_YEAR, classId, await hash(temporaryPassword, 12)],
  );
  await audit(actorId, "student_account_created", "user", studentId, {
    classNumber: parsed.classNumber,
    studentNumber: parsed.studentNumber,
  });
  return { name, loginId: parsed.loginId, temporaryPassword, classNumber: parsed.classNumber };
}

export async function deactivateStudent(actorId: string, studentId: string) {
  const db = await getDb();
  const student = await db.query<{ status: string }>(
    "SELECT status FROM users WHERE id = $1 AND role = 'student'",
    [studentId],
  );
  if (!student.rows[0]) throw new Error("학생을 찾을 수 없습니다.");
  if (student.rows[0].status === "inactive") throw new Error("이미 비활성화된 학생입니다.");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET status = 'inactive' WHERE id = $1 AND role = 'student'", [studentId]);
    await client.query(
      `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND status = 'active'`,
      [studentId],
    );
    await client.query("UPDATE teams SET leader_user_id = NULL WHERE leader_user_id = $1", [studentId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actorId, "student_account_deactivated", "user", studentId);
}

export async function restoreStudent(actorId: string, studentId: string) {
  const db = await getDb();
  const result = await db.query(
    `UPDATE users SET status = 'active'
      WHERE id = $1 AND role = 'student' AND status = 'inactive'
      RETURNING id`,
    [studentId],
  );
  if (result.rowCount !== 1) throw new Error("복원할 비활성 학생을 찾을 수 없습니다.");
  await audit(actorId, "student_account_restored", "user", studentId);
}
