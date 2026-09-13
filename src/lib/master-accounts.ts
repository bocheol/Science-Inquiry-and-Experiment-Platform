import { hash } from "bcryptjs";
import { updatePassword } from "@/lib/auth";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { audit, getDb } from "@/lib/db";
import { createId } from "@/lib/id";
import { generateTemporaryPassword } from "@/lib/passwords";
import { lockStudentTeams } from "@/lib/team-mutation-locks";
import { UserFacingError } from "@/lib/user-facing-error";

export type ManagedAccount = {
  id: string;
  name: string;
  loginId: string;
  role: "teacher" | "student";
  accountType: "standard" | "demo";
  status: "active" | "inactive";
  mustChangePassword: boolean;
  isMaster: boolean;
  createdAt: string;
};

export type MasterAccountData = {
  teachers: ManagedAccount[];
  demoStudents: ManagedAccount[];
};

export type OneTimeCredential = {
  name: string;
  loginId: string;
  temporaryPassword: string;
};

export async function assertMasterActor(actorId: string) {
  const db = await getDb();
  const result = await db.query(
    `SELECT id FROM users
      WHERE id = $1 AND role = 'teacher' AND is_master = TRUE
        AND status = 'active' AND must_change_password = FALSE AND academic_year = $2`,
    [actorId, ACADEMIC_YEAR],
  );
  if (!result.rows[0]) throw new UserFacingError("마스터 관리자 권한이 필요합니다.");
}

function validateName(name: string) {
  const value = name.trim();
  if (!value || value.length > 80) throw new UserFacingError("이름은 1자 이상 80자 이하로 입력해 주세요.");
  return value;
}

function validateLoginId(loginId: string, kind: "teacher" | "demo") {
  const value = loginId.trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{2,39}$/.test(value)) {
    throw new UserFacingError("아이디는 영문으로 시작하는 3~40자의 영문·숫자·점·밑줄·붙임표로 입력해 주세요.");
  }
  if (kind === "demo" && !value.toLowerCase().startsWith("demo-")) {
    throw new UserFacingError("체험 학생 아이디는 실제 학번과 구분되도록 demo-로 시작해 주세요.");
  }
  return value;
}

function accountDto(row: {
  id: string; name: string; login_id: string; role: "teacher" | "student";
  account_type: "standard" | "demo"; status: "active" | "inactive";
  must_change_password: boolean; is_master: boolean; created_at: Date | string;
}): ManagedAccount {
  return {
    id: row.id,
    name: row.name,
    loginId: row.login_id,
    role: row.role,
    accountType: row.account_type,
    status: row.status,
    mustChangePassword: row.must_change_password,
    isMaster: row.is_master,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function getMasterAccountData(actorId: string): Promise<MasterAccountData> {
  await assertMasterActor(actorId);
  const db = await getDb();
  const result = await db.query<{
    id: string; name: string; login_id: string; role: "teacher" | "student";
    account_type: "standard" | "demo"; status: "active" | "inactive";
    must_change_password: boolean; is_master: boolean; created_at: Date | string;
  }>(
    `SELECT id, name, login_id, role, account_type, status, must_change_password, is_master, created_at
       FROM users
      WHERE academic_year = $1
        AND (role = 'teacher' OR account_type = 'demo')
      ORDER BY role DESC, created_at, login_id`,
    [ACADEMIC_YEAR],
  );
  const accounts = result.rows.map(accountDto);
  return {
    teachers: accounts.filter((account) => account.role === "teacher"),
    demoStudents: accounts.filter((account) => account.role === "student" && account.accountType === "demo"),
  };
}

export async function createManagedAccount(
  actorId: string,
  input: { kind: "teacher" | "demo"; name: string; loginId: string },
): Promise<OneTimeCredential> {
  await assertMasterActor(actorId);
  const name = validateName(input.name);
  const loginId = validateLoginId(input.loginId, input.kind);
  const db = await getDb();
  const existing = await db.query("SELECT id FROM users WHERE academic_year = $1 AND login_id = $2", [ACADEMIC_YEAR, loginId]);
  if (existing.rows[0]) throw new UserFacingError("이미 사용 중인 아이디입니다.");
  const temporaryPassword = generateTemporaryPassword();
  const id = createId("user");
  const role = input.kind === "teacher" ? "teacher" : "student";
  const accountType = input.kind === "teacher" ? "standard" : "demo";
  await db.query(
    `INSERT INTO users
      (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password, account_type, is_master, status)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, TRUE, $7, FALSE, 'active')`,
    [id, name, loginId, ACADEMIC_YEAR, role, await hash(temporaryPassword, 12), accountType],
  );
  await audit(actorId, input.kind === "teacher" ? "teacher_account_created" : "demo_student_account_created", "user", id, {
    role,
    accountType,
  });
  return { name, loginId, temporaryPassword };
}

async function managedTarget(accountId: string) {
  const db = await getDb();
  const result = await db.query<{
    id: string; name: string; login_id: string; role: "teacher" | "student";
    account_type: "standard" | "demo"; status: "active" | "inactive"; is_master: boolean;
  }>(
    `SELECT id, name, login_id, role, account_type, status, is_master
       FROM users WHERE id = $1 AND academic_year = $2 AND (role = 'teacher' OR account_type = 'demo')`,
    [accountId, ACADEMIC_YEAR],
  );
  const target = result.rows[0];
  if (!target) throw new UserFacingError("관리할 계정을 찾을 수 없습니다.");
  return target;
}

export async function changeManagedAccountStatus(actorId: string, accountId: string, action: "deactivate" | "restore") {
  await assertMasterActor(actorId);
  const target = await managedTarget(accountId);
  if (target.id === actorId) throw new UserFacingError("현재 로그인한 마스터 계정은 비활성화할 수 없습니다.");
  if (target.is_master) throw new UserFacingError("마스터 계정 상태는 이 화면에서 변경할 수 없습니다.");
  if (action === "deactivate" && target.status === "inactive") throw new UserFacingError("이미 비활성화된 계정입니다.");
  if (action === "restore" && target.status === "active") throw new UserFacingError("이미 활성 상태인 계정입니다.");
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (target.role === "student") await lockStudentTeams(client, accountId);
    const changed = await client.query(
      `UPDATE users
          SET status = $1,
              session_version = session_version + CASE WHEN $1 = 'inactive' THEN 1 ELSE 0 END
        WHERE id = $2 AND academic_year = $3 RETURNING id`,
      [action === "deactivate" ? "inactive" : "active", accountId, ACADEMIC_YEAR],
    );
    if (changed.rowCount !== 1) throw new UserFacingError("관리할 계정을 찾을 수 없습니다.");
    if (action === "deactivate" && target.role === "student") {
      const currentTeams = `SELECT t.id FROM teams t LEFT JOIN classes c ON c.id = t.class_id
        LEFT JOIN clubs cl ON cl.id = t.club_id WHERE COALESCE(c.academic_year, cl.academic_year) = $2`;
      await client.query(`UPDATE team_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND status = 'active' AND team_id IN (${currentTeams})`, [accountId, ACADEMIC_YEAR]);
      await client.query(`UPDATE club_members SET status = 'inactive', left_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND status = 'active' AND club_id IN (SELECT id FROM clubs WHERE academic_year = $2)`, [accountId, ACADEMIC_YEAR]);
      await client.query(`UPDATE teams SET leader_user_id = NULL WHERE leader_user_id = $1 AND id IN (${currentTeams})`, [accountId, ACADEMIC_YEAR]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actorId, action === "deactivate" ? "managed_account_deactivated" : "managed_account_restored", "user", accountId, {
    role: target.role,
    accountType: target.account_type,
  });
}

export async function resetManagedAccountPassword(actorId: string, accountId: string): Promise<OneTimeCredential> {
  await assertMasterActor(actorId);
  const target = await managedTarget(accountId);
  if (target.id === actorId) throw new UserFacingError("현재 계정의 비밀번호는 내 비밀번호 변경 화면에서 바꿔 주세요.");
  const temporaryPassword = generateTemporaryPassword();
  await updatePassword(accountId, temporaryPassword, true);
  await audit(actorId, "managed_account_password_reset", "user", accountId, {
    role: target.role,
    accountType: target.account_type,
  });
  return { name: target.name, loginId: target.login_id, temporaryPassword };
}
