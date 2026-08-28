import { hash } from "bcryptjs";
import * as XLSX from "xlsx";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { generateTemporaryPassword } from "@/lib/passwords";

type SourceRow = {
  반?: string | number;
  번호?: string | number;
  성명?: string;
  "조 번호"?: string | number;
};

export type IssuedCredential = {
  name: string;
  loginId: string;
  temporaryPassword: string;
  classNumber: number;
};

function toInteger(value: unknown, label: string) {
  const parsed = Number(String(value ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isInteger(parsed)) throw new Error(`${label} 값을 확인해 주세요.`);
  return parsed;
}

function makeLoginId(classNumber: number, studentNumber: number) {
  return `1${String(classNumber).padStart(2, "0")}${String(studentNumber).padStart(2, "0")}`;
}

async function mapWithConcurrency<T, U>(items: T[], limit: number, task: (item: T) => Promise<U>) {
  const results = new Array<U>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function importRoster(buffer: ArrayBuffer, actorId: string) {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("학생 명단에 시트가 없습니다.");
  const rows = XLSX.utils.sheet_to_json<SourceRow>(workbook.Sheets[firstSheetName], { defval: "" });
  if (!rows.length) throw new Error("학생 명단이 비어 있습니다.");

  const records = rows.map((row, index) => {
    const classNumber = toInteger(row.반, `${index + 2}행 반`);
    const studentNumber = toInteger(row.번호, `${index + 2}행 번호`);
    const name = String(row.성명 ?? "").trim();
    const teamDigits = String(row["조 번호"] ?? "").replace(/[^0-9]/g, "");
    const teamNumber = teamDigits ? Number(teamDigits) : null;
    if (classNumber < 1 || classNumber > 9) throw new Error(`${index + 2}행 반은 1~9여야 합니다.`);
    if (studentNumber < 1 || studentNumber > 99) throw new Error(`${index + 2}행 번호를 확인해 주세요.`);
    if (!name) throw new Error(`${index + 2}행 성명이 비어 있습니다.`);
    return { classNumber, studentNumber, name, teamNumber, loginId: makeLoginId(classNumber, studentNumber) };
  });

  const duplicate = records.find((record, index) => records.findIndex((item) => item.loginId === record.loginId) !== index);
  if (duplicate) throw new Error(`학번 ${duplicate.loginId}이(가) 두 번 있습니다.`);

  const db = await getDb();
  const client = await db.connect();
  const issued: IssuedCredential[] = [];
  try {
    await client.query("BEGIN");
    const prepared = await mapWithConcurrency(records, 6, async (record) => {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE academic_year = $1 AND login_id = $2",
        [ACADEMIC_YEAR, record.loginId],
      );
      if (existing.rows[0]) return { ...record, userId: existing.rows[0].id, passwordHash: null, temporaryPassword: null };
      const temporaryPassword = generateTemporaryPassword();
      return {
        ...record,
        userId: createId("user"),
        passwordHash: await hash(temporaryPassword, 10),
        temporaryPassword,
      };
    });

    for (const record of prepared) {
      const classId = `class_${ACADEMIC_YEAR}_${record.classNumber}`;
      if (record.passwordHash) {
        await client.query(
          `INSERT INTO users
            (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
           VALUES ($1, $2, $3, $4, 'student', $5, $6, TRUE)`,
          [record.userId, record.name, record.loginId, ACADEMIC_YEAR, classId, record.passwordHash],
        );
        issued.push({
          name: record.name,
          loginId: record.loginId,
          temporaryPassword: record.temporaryPassword!,
          classNumber: record.classNumber,
        });
      } else {
        await client.query(
          "UPDATE users SET name = $1, class_id = $2, status = 'active' WHERE id = $3",
          [record.name, classId, record.userId],
        );
      }

      if (record.teamNumber) {
        const teamId = `team_${ACADEMIC_YEAR}_${record.classNumber}_${record.teamNumber}`;
        await client.query(
          `INSERT INTO teams (id, class_id, team_number, name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (class_id, team_number) DO UPDATE SET name = EXCLUDED.name`,
          [teamId, classId, record.teamNumber, `${record.teamNumber}조`],
        );
        await client.query(
          `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
            WHERE user_id = $1 AND status = 'active' AND team_id <> $2`,
          [record.userId, teamId],
        );
        const membership = await client.query(
          "SELECT id FROM team_members WHERE user_id = $1 AND team_id = $2 AND status = 'active'",
          [record.userId, teamId],
        );
        if (!membership.rows[0]) {
          await client.query(
            "INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $2, $3)",
            [createId("member"), teamId, record.userId],
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await audit(actorId, "roster_imported", "roster", null, {
    rowCount: records.length,
    newAccountCount: issued.length,
  });
  return { total: records.length, issued };
}

