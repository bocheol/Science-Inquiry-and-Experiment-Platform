import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hash } from "bcryptjs";
import pg from "pg";

const { Pool } = pg;
const ACADEMIC_YEAR = 2026;
const INITIAL_KEYS = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];
const MEDIAL_KEYS = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"];
const FINAL_KEYS = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"];

function hangulToDubeolsik(value) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0xac00 || codePoint > 0xd7a3) return character;
    const syllableOffset = codePoint - 0xac00;
    return `${INITIAL_KEYS[Math.floor(syllableOffset / 588)]}${MEDIAL_KEYS[Math.floor((syllableOffset % 588) / 28)]}${FINAL_KEYS[syllableOffset % 28]}`;
  }).join("");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`필수 인수가 없습니다: ${name}`);
  return process.argv[index + 1];
}

function parseTeacherDistribution(text) {
  const lines = text.split(/\r?\n/);
  const teachers = [];
  let currentLoginId = null;
  let passwordCount = 0;
  const convertedLines = lines.map((line) => {
    const loginMatch = line.match(/^아이디:\s*(\S+)\s*$/);
    if (loginMatch) {
      currentLoginId = loginMatch[1];
      return line;
    }
    const passwordMatch = line.match(/^임시 비밀번호:\s*(\S+)\s*$/);
    if (!passwordMatch) return line;
    if (!currentLoginId) throw new Error("교사 배부 파일 구성이 예상과 다릅니다.");
    const temporaryPassword = hangulToDubeolsik(passwordMatch[1]);
    if (/[가-힣]/.test(temporaryPassword)) throw new Error("교사 비밀번호 변환에 실패했습니다.");
    teachers.push({ loginId: currentLoginId, role: "teacher", temporaryPassword });
    passwordCount += 1;
    currentLoginId = null;
    return `임시 비밀번호: ${temporaryPassword}`;
  });
  if (teachers.length !== 4 || passwordCount !== 4) throw new Error("교사 배부 파일 계정 수가 예상과 다릅니다.");
  return { teachers, convertedText: `${convertedLines.join("\n").replace(/\n+$/, "")}\n` };
}

async function hashInBatches(accounts, batchSize = 6) {
  const hashed = [];
  for (let index = 0; index < accounts.length; index += batchSize) {
    const batch = accounts.slice(index, index + batchSize);
    hashed.push(
      ...(await Promise.all(
        batch.map(async (account) => ({ ...account, passwordHash: await hash(account.temporaryPassword, 12) })),
      )),
    );
  }
  return hashed;
}

const studentPath = resolve(argumentValue("--students"));
const teacherPath = resolve(argumentValue("--teachers"));
const teacherOutputPath = resolve(argumentValue("--teacher-output"));
const dryRun = process.argv.includes("--dry-run");

const studentPayload = JSON.parse(await readFile(studentPath, "utf8"));
const students = (studentPayload.issued ?? []).map((credential) => ({
  loginId: String(credential.loginId),
  role: "student",
  temporaryPassword: String(credential.temporaryPassword),
}));
if (students.length !== 282 || students.some((student) => /[가-힣]/.test(student.temporaryPassword))) {
  throw new Error("학생 임시 로그인 자료 구성이 예상과 다릅니다.");
}

const { teachers, convertedText } = parseTeacherDistribution(await readFile(teacherPath, "utf8"));
const demoTails = JSON.parse(process.env.SCIENCE_DEMO_PASSWORD_TAILS_JSON ?? "null");
if (!Array.isArray(demoTails) || demoTails.length !== 4) throw new Error("체험 계정 재발급 정보가 없습니다.");
const demos = demoTails.map((entry) => {
  const loginId = String(entry?.loginId ?? "");
  const tail = String(entry?.tail ?? "");
  if (!/^1\d{4}$/.test(loginId) || !/^[A-Za-z0-9!#?]+$/.test(tail)) {
    throw new Error("체험 계정 재발급 정보 구성이 예상과 다릅니다.");
  }
  return { loginId, role: "student", temporaryPassword: `${hangulToDubeolsik("체험")}${tail}` };
});

const accounts = [...students, ...demos, ...teachers];
const loginIds = accounts.map((account) => account.loginId);
if (accounts.length !== 290 || new Set(loginIds).size !== accounts.length) {
  throw new Error("재발급 대상 계정 수 또는 중복 여부가 예상과 다릅니다.");
}

const secrets = JSON.parse(await readFile(resolve(".deployment-secrets.local.json"), "utf8"));
const pool = new Pool({
  host: process.env.SCIENCE_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.SCIENCE_DB_PORT ?? 5433),
  user: "science_app",
  password: secrets.DB_PASSWORD,
  database: "science_platform",
  max: 1,
  connectionTimeoutMillis: 15_000,
});

const client = await pool.connect();
try {
  const current = await client.query(
    `SELECT login_id, role
       FROM users
      WHERE academic_year = $1
        AND status = 'active'
        AND role IN ('student', 'teacher')`,
    [ACADEMIC_YEAR],
  );
  const currentByLoginId = new Map(current.rows.map((row) => [row.login_id, row.role]));
  const exactMatch =
    current.rows.length === accounts.length &&
    accounts.every((account) => currentByLoginId.get(account.loginId) === account.role);
  if (!exactMatch) throw new Error("운영 DB의 활성 계정 구성과 재발급 대상이 일치하지 않습니다.");

  if (dryRun) {
    console.log(JSON.stringify({ students: students.length + demos.length, teachers: teachers.length, exactMatch: true }));
  } else {
    await writeFile(teacherOutputPath, convertedText, { encoding: "utf8", mode: 0o600 });
    const hashedAccounts = await hashInBatches(accounts);
    await client.query("BEGIN");
    try {
      let updated = 0;
      for (const account of hashedAccounts) {
        const result = await client.query(
          `UPDATE users
              SET password_hash = $1,
                  must_change_password = TRUE
            WHERE academic_year = $2
              AND status = 'active'
              AND login_id = $3
              AND role = $4`,
          [account.passwordHash, ACADEMIC_YEAR, account.loginId, account.role],
        );
        updated += result.rowCount ?? 0;
      }
      if (updated !== accounts.length) throw new Error("운영 DB 비밀번호 재설정 건수가 예상과 다릅니다.");
      await client.query(
        `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, detail)
         VALUES ($1, NULL, 'bulk_initial_passwords_reissued', 'users', NULL, $2)`,
        [
          `audit_${randomUUID()}`,
          JSON.stringify({
            academicYear: ACADEMIC_YEAR,
            students: students.length + demos.length,
            teachers: teachers.length,
            format: "dubeolsik_qwerty",
          }),
        ],
      );
      await client.query("COMMIT");
      console.log(JSON.stringify({ students: students.length + demos.length, teachers: teachers.length, updated }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
