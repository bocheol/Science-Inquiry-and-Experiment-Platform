import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const values = JSON.parse(readFileSync(resolve(".deployment-secrets.local.json"), "utf8"));
const envText = readFileSync(resolve(".env.local"), "utf8");
const openAiLine = envText.split(/\r?\n/).find((line) => line.startsWith("OPENAI_API_KEY="));
if (!openAiLine || openAiLine.length <= "OPENAI_API_KEY=".length) {
  throw new Error("OPENAI_API_KEY를 찾지 못했습니다.");
}

const outputDir = resolve(".deployment-secret-files");
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const files = {
  "science-db-password": values.DB_PASSWORD,
  "science-session-secret": values.SESSION_SECRET,
  "science-bootstrap-teacher-password": values.BOOTSTRAP_TEACHER_PASSWORD,
  "science-openai-api-key": openAiLine.slice("OPENAI_API_KEY=".length),
};

for (const [name, value] of Object.entries(files)) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`비밀값이 비어 있습니다: ${name}`);
  writeFileSync(resolve(outputDir, name), value, { encoding: "utf8", mode: 0o600 });
}

console.log("Secret Manager 전송용 파일 4개를 준비했습니다.");
