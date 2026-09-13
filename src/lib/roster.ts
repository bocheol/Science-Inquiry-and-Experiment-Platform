import { hash } from "bcryptjs";
import {parseRoster, RosterInputError} from "@/lib/roster-parser";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { generateTemporaryPassword } from "@/lib/passwords";
import { lockStudentsTeams } from "@/lib/team-mutation-locks";
import { ensureSession } from "@/lib/teams";


export type IssuedCredential = {
  name: string;
  loginId: string;
  temporaryPassword: string;
  classNumber: number;
};

function toInteger(value: unknown, label: string) {
  const parsed = Number(String(value ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isInteger(parsed)) throw new RosterInputError(`${label} 값을 확인해 주세요.`);
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
  const rows = await parseRoster(buffer);
  if (!rows.length) throw new RosterInputError("학생 명단이 비어 있습니다.");

  const records = rows.map((row, index) => {
    const classNumber = toInteger(row.반, `${index + 2}행 반`);
    const studentNumber = toInteger(row.번호, `${index + 2}행 번호`);
    const name = String(row.성명 ?? "").trim();
    const teamDigits = String(row["조 번호"] ?? "").replace(/[^0-9]/g, "");
    const teamNumber = teamDigits ? Number(teamDigits) : null;
    if (classNumber < 1 || classNumber > 9) throw new RosterInputError(`${index + 2}행 반은 1~9여야 합니다.`);
    if (studentNumber < 1 || studentNumber > 99) throw new RosterInputError(`${index + 2}행 번호를 확인해 주세요.`);
    if (!name) throw new RosterInputError(`${index + 2}행 성명이 비어 있습니다.`);
    if (teamNumber !== null && (teamNumber < 1 || teamNumber > 20)) throw new RosterInputError(`${index + 2}행 조 번호는 1~20이어야 합니다.`);
    return { classNumber, studentNumber, name, teamNumber, loginId: makeLoginId(classNumber, studentNumber) };
  });

  const duplicate = records.find((record, index) => records.findIndex((item) => item.loginId === record.loginId) !== index);
  if (duplicate) throw new RosterInputError("명단에 같은 학번이 두 번 있습니다.");

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

    // Bulk imports acquire all class, then student, then team locks before
    // changing memberships, avoiding a user/team lock inversion across rows.
    const targetIds: string[] = [];
    for (const classNumber of [...new Set(prepared.map(record => record.classNumber))].sort((a, b) => a - b)) {
      const classId = `class_${ACADEMIC_YEAR}_${classNumber}`;
      await client.query("SELECT id FROM classes WHERE id = $1 FOR UPDATE", [classId]);
      const teams = await client.query<{ id: string }>("SELECT id FROM teams WHERE class_id = $1", [classId]);
      targetIds.push(...teams.rows.map(team => team.id));
    }
    await lockStudentsTeams(client, prepared.filter(record => !record.passwordHash).map(record => record.userId), targetIds);
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
        const proposedTeamId = `team_${ACADEMIC_YEAR}_${record.classNumber}_${record.teamNumber}`;
        const teamResult = await client.query<{ id: string; status: string }>(
          `INSERT INTO teams (id, class_id, team_number, name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (class_id, team_number) DO UPDATE SET name = teams.name RETURNING id, status`,
          [proposedTeamId, classId, record.teamNumber, `${record.teamNumber}조`],
        );
        const teamId = teamResult.rows[0].id;
        if (teamResult.rows[0].status !== "active") throw new RosterInputError("보관된 팀에는 명단으로 학생을 배정할 수 없습니다. 먼저 팀을 복원해 주세요.");
        await client.query(
          `UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
            WHERE user_id = $1 AND status = 'active' AND team_id <> $2
              AND team_id IN (SELECT id FROM teams WHERE club_id IS NULL)`,
          [record.userId, teamId],
        );
        await client.query("UPDATE teams SET leader_user_id = NULL WHERE club_id IS NULL AND id <> $1 AND leader_user_id = $2", [teamId, record.userId]);
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
        await ensureSession(client, teamId);
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
