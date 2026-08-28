import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const secretsPath = resolve(".deployment-secrets.local.json");
const teacherLoginPath = resolve("teacher-login.txt");

if (existsSync(secretsPath) || existsSync(teacherLoginPath)) {
  throw new Error("배포 비밀값 파일이 이미 있습니다. 기존 값을 덮어쓰지 않았습니다.");
}

const randomSecret = (bytes) => randomBytes(bytes).toString("base64url");
const values = {
  DB_PASSWORD: randomSecret(24),
  SESSION_SECRET: randomSecret(48),
  BOOTSTRAP_TEACHER_PASSWORD: randomSecret(18),
};

writeFileSync(secretsPath, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
writeFileSync(
  teacherLoginPath,
  [
    "과탐실 AI 탐구 플랫폼 교사 임시 로그인",
    "",
    "아이디: teacher",
    `임시 비밀번호: ${values.BOOTSTRAP_TEACHER_PASSWORD}`,
    "",
    "첫 로그인 직후 새 비밀번호로 변경하세요.",
  ].join("\n"),
  { encoding: "utf8", mode: 0o600 },
);

console.log("배포용 비밀값과 교사 임시 로그인 파일을 생성했습니다.");
