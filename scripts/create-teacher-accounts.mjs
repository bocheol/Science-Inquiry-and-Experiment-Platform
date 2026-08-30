import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compare, hash } from "bcryptjs";
import pg from "pg";

const { Pool } = pg;
const ACADEMIC_YEAR = 2026;
const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("배포 URL이 필요합니다.");

const teachers = [
  { loginId: "teacher1", name: "강석봉" },
  { loginId: "teacher2", name: "김보철" },
  { loginId: "teacher3", name: "김정원" },
  { loginId: "teacher4", name: "원창연" },
];
const words = ["별빛", "새싹", "바다", "구름", "나무", "여울", "노을", "하늘", "우주", "달빛"];
const symbols = ["!", "#", "?"];
const INITIAL_KEYS = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];
const MEDIAL_KEYS = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"];
const FINAL_KEYS = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"];
const tempDir = resolve("tmp", "teacher-accounts");
const tempPath = resolve(tempDir, "credentials.json");
const distributionPath = resolve("teacher-accounts.txt");

function hangulToDubeolsik(value) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0xac00 || codePoint > 0xd7a3) return character;

    const syllableOffset = codePoint - 0xac00;
    const initialIndex = Math.floor(syllableOffset / 588);
    const medialIndex = Math.floor((syllableOffset % 588) / 28);
    const finalIndex = syllableOffset % 28;
    return `${INITIAL_KEYS[initialIndex]}${MEDIAL_KEYS[medialIndex]}${FINAL_KEYS[finalIndex]}`;
  }).join("");
}

function makeTemporaryPassword() {
  const word = hangulToDubeolsik(words[randomInt(words.length)]);
  return `${word}${randomInt(10_000, 100_000)}${symbols[randomInt(symbols.length)]}`;
}

await mkdir(tempDir, { recursive: true });
let credentials;
if (existsSync(tempPath)) {
  credentials = JSON.parse(await readFile(tempPath, "utf8"));
} else {
  credentials = teachers.map((teacher) => ({ ...teacher, temporaryPassword: makeTemporaryPassword() }));
  await writeFile(tempPath, `${JSON.stringify(credentials)}\n`, { encoding: "utf8", mode: 0o600 });
}

if (
  credentials.length !== teachers.length ||
  teachers.some((teacher, index) => teacher.loginId !== credentials[index]?.loginId || teacher.name !== credentials[index]?.name)
) {
  throw new Error("임시 교사 계정 파일의 구성이 예상과 다릅니다.");
}

const distributionText = [
  "과탐실 AI 탐구 플랫폼 교사 임시 로그인",
  "",
  `접속 주소: ${baseUrl}`,
  "",
  ...credentials.flatMap((credential, index) => [
    `${index + 1}. ${credential.name}`,
    `아이디: ${credential.loginId}`,
    `임시 비밀번호: ${credential.temporaryPassword}`,
    "",
  ]),
  "첫 로그인 직후 본인 비밀번호로 변경하세요.",
  "교사 계정은 9개 학급 전체를 공동 관리합니다.",
  "",
].join("\n");
await writeFile(distributionPath, distributionText, { encoding: "utf8", mode: 0o600 });

const localSecrets = JSON.parse(await readFile(resolve(".deployment-secrets.local.json"), "utf8"));
const pool = new Pool({
  host: "127.0.0.1",
  port: Number(process.env.SCIENCE_DB_PROXY_PORT ?? 5433),
  user: "science_app",
  password: localSecrets.DB_PASSWORD,
  database: "science_platform",
  max: 1,
  connectionTimeoutMillis: 15_000,
});

const client = await pool.connect();
let createdCount = 0;
try {
  await client.query("BEGIN");
  const existing = await client.query(
    `SELECT id, name, login_id, password_hash
       FROM users
      WHERE academic_year = $1 AND login_id = ANY($2::text[])
      ORDER BY login_id`,
    [ACADEMIC_YEAR, teachers.map((teacher) => teacher.loginId)],
  );

  if (existing.rows.length === 0) {
    for (const credential of credentials) {
      const id = `teacher_${ACADEMIC_YEAR}_${credential.loginId}_${randomUUID().slice(0, 8)}`;
      await client.query(
        `INSERT INTO users
          (id, name, login_id, academic_year, role, password_hash, must_change_password, status)
         VALUES ($1, $2, $3, $4, 'teacher', $5, TRUE, 'active')`,
        [id, credential.name, credential.loginId, ACADEMIC_YEAR, await hash(credential.temporaryPassword, 12)],
      );
      createdCount += 1;
    }
  } else if (existing.rows.length === teachers.length) {
    for (const credential of credentials) {
      const record = existing.rows.find((row) => row.login_id === credential.loginId);
      if (!record || record.name !== credential.name || !(await compare(credential.temporaryPassword, record.password_hash))) {
        throw new Error("이미 존재하는 교사 계정과 임시 로그인 파일이 일치하지 않습니다.");
      }
      await client.query("UPDATE users SET status = 'active', must_change_password = TRUE WHERE id = $1", [record.id]);
    }
  } else {
    throw new Error("일부 교사 계정만 존재합니다. 수동 확인이 필요합니다.");
  }

  await client.query(
    "UPDATE users SET status = 'inactive' WHERE academic_year = $1 AND login_id = 'teacher' AND role = 'teacher'",
    [ACADEMIC_YEAR],
  );

  if (createdCount > 0) {
    await client.query(
      `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'teacher_bootstrap', 'teacher_accounts_created', 'users', NULL, $2)`,
      [`audit_${randomUUID()}`, JSON.stringify({ loginIds: teachers.map((teacher) => teacher.loginId), count: createdCount })],
    );
  }

  const result = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE role = 'teacher' AND status = 'active')::int AS active_teachers,
       COUNT(*) FILTER (WHERE login_id = 'teacher' AND status = 'inactive')::int AS inactive_bootstrap
     FROM users
     WHERE academic_year = $1`,
    [ACADEMIC_YEAR],
  );
  await client.query("COMMIT");

  console.log(
    JSON.stringify({
      created: createdCount,
      activeTeachers: result.rows[0].active_teachers,
      bootstrapInactive: result.rows[0].inactive_bootstrap === 1,
      credentialsSaved: true,
    }),
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
