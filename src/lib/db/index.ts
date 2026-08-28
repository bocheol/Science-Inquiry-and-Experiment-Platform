import { hash } from "bcryptjs";
import { newDb } from "pg-mem";
import { Pool } from "pg";
import { ACADEMIC_YEAR } from "@/lib/constants";
import { createId } from "@/lib/id";
import { SCHEMA_SQL } from "@/lib/db/schema";

type GlobalDb = typeof globalThis & {
  __sciencePool?: Pool;
  __scienceDbReady?: Promise<Pool>;
};

const globalDb = globalThis as GlobalDb;

function makePool() {
  if (process.env.INSTANCE_UNIX_SOCKET) {
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const database = process.env.DB_NAME;
    if (!user || !password || !database) {
      throw new Error("Cloud SQL 연결에는 DB_USER, DB_PASSWORD, DB_NAME이 모두 필요합니다.");
    }

    return new Pool({
      host: process.env.INSTANCE_UNIX_SOCKET,
      user,
      password,
      database,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "운영 환경에는 영구 PostgreSQL 연결 설정(DATABASE_URL 또는 Cloud SQL 소켓 설정)이 필요합니다. 로컬 메모리 DB로는 실행하지 않습니다.",
    );
  }

  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as unknown as Pool;
}

async function seed(pool: Pool) {
  const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  if (Number(rows[0]?.count ?? 0) > 0) return;

  for (let classNumber = 1; classNumber <= 9; classNumber += 1) {
    await pool.query(
      "INSERT INTO classes (id, academic_year, class_number, name) VALUES ($1, $2, $3, $4)",
      [`class_${ACADEMIC_YEAR}_${classNumber}`, ACADEMIC_YEAR, classNumber, `1학년 ${classNumber}반`],
    );
  }

  const teacherPassword =
    process.env.BOOTSTRAP_TEACHER_PASSWORD ||
    (process.env.NODE_ENV === "production" ? "" : "teacher1234");
  if (!teacherPassword) {
    throw new Error("운영 환경에는 BOOTSTRAP_TEACHER_PASSWORD가 필요합니다.");
  }

  await pool.query(
    `INSERT INTO users
      (id, name, login_id, academic_year, role, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4, 'teacher', $5, $6)`,
    [
      "teacher_bootstrap",
      "과학 선생님",
      process.env.BOOTSTRAP_TEACHER_LOGIN ?? "teacher",
      ACADEMIC_YEAR,
      await hash(teacherPassword, 12),
      process.env.NODE_ENV === "production",
    ],
  );

  if (process.env.NODE_ENV !== "production") {
    const classId = `class_${ACADEMIC_YEAR}_9`;
    const demoPasswordHash = await hash("student1234", 12);
    const students = [
      ["demo_student_1", "김하늘", "10901"],
      ["demo_student_2", "이새봄", "10902"],
      ["demo_student_3", "박지우", "10903"],
    ] as const;
    for (const [id, name, loginId] of students) {
      await pool.query(
        `INSERT INTO users
          (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, 'student', $5, $6, FALSE)`,
        [id, name, loginId, ACADEMIC_YEAR, classId, demoPasswordHash],
      );
    }
    await pool.query(
      "INSERT INTO teams (id, class_id, team_number, name, leader_user_id) VALUES ($1, $2, 1, $3, $4)",
      ["demo_team_1", classId, "1조", "demo_student_1"],
    );
    for (const [studentId] of students) {
      await pool.query(
        "INSERT INTO team_members (id, team_id, user_id) VALUES ($1, $2, $3)",
        [createId("member"), "demo_team_1", studentId],
      );
    }
    await pool.query(
      `INSERT INTO inquiry_sessions (id, team_id, interest_input, stage)
       VALUES ('demo_session_1', 'demo_team_1', '생활 속 산과 염기의 변화를 측정해 보고 싶어요', 'EXPERIMENTING')`,
    );
    await pool.query(
      `INSERT INTO investigation_plans (id, session_id, form_data, review_status)
       VALUES ('demo_plan_1', 'demo_session_1', $1, 'approved')`,
      [JSON.stringify({ field: "화학", topic: "" })],
    );
    await pool.query("INSERT INTO reports (id, session_id) VALUES ('report_demo_session_1', 'demo_session_1')");
  }
}

async function initialize() {
  const pool = makePool();
  await pool.query(SCHEMA_SQL);
  await seed(pool);
  globalDb.__sciencePool = pool;
  return pool;
}

export async function getDb() {
  if (globalDb.__sciencePool) return globalDb.__sciencePool;
  globalDb.__scienceDbReady ??= initialize();
  return globalDb.__scienceDbReady;
}

export async function audit(
  actorId: string | null,
  action: string,
  entityType: string,
  entityId?: string | null,
  detail: Record<string, unknown> = {},
) {
  const db = await getDb();
  await db.query(
    `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [createId("audit"), actorId, action, entityType, entityId ?? null, JSON.stringify(detail)],
  );
}
