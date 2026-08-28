import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.argv[2];
const rosterPath = process.argv[3];
if (!baseUrl || !rosterPath) throw new Error("배포 URL과 학생 명단 경로가 필요합니다.");

const localSecrets = JSON.parse(await readFile(resolve(".deployment-secrets.local.json"), "utf8"));
const outputDir = resolve("tmp", "pdfs");
const credentialsPath = resolve(outputDir, "student-credentials.json");
await mkdir(outputDir, { recursive: true });

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ loginId: "teacher", password: localSecrets.BOOTSTRAP_TEACHER_PASSWORD }),
  signal: AbortSignal.timeout(180_000),
});
if (!loginResponse.ok) throw new Error(`교사 로그인 실패: ${loginResponse.status}`);
const loginResult = await loginResponse.json();
const setCookie = loginResponse.headers.getSetCookie?.()[0] ?? loginResponse.headers.get("set-cookie");
const cookie = setCookie?.split(";", 1)[0];
if (!cookie) throw new Error("교사 로그인 쿠키를 받지 못했습니다.");

const rosterBytes = await readFile(rosterPath);
const form = new FormData();
form.append("file", new Blob([rosterBytes]), "학생 명단.xlsx");
const uploadResponse = await fetch(`${baseUrl}/api/teacher/roster`, {
  method: "POST",
  headers: { cookie },
  body: form,
  signal: AbortSignal.timeout(300_000),
});
const uploadResult = await uploadResponse.json();
if (!uploadResponse.ok) throw new Error(uploadResult.message ?? `명단 등록 실패: ${uploadResponse.status}`);

await writeFile(
  credentialsPath,
  `${JSON.stringify({ baseUrl, issued: uploadResult.issued ?? [] })}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const dashboardResponse = await fetch(`${baseUrl}/api/teacher/roster`, {
  headers: { cookie },
  signal: AbortSignal.timeout(180_000),
});
if (!dashboardResponse.ok) throw new Error(`등록 확인 실패: ${dashboardResponse.status}`);
const dashboard = await dashboardResponse.json();

console.log(
  JSON.stringify({
    loginDestination: loginResult.destination,
    sourceRows: uploadResult.total,
    newAccounts: uploadResult.issued?.length ?? 0,
    databaseStudents: dashboard.counts?.students ?? null,
    databaseTeams: dashboard.counts?.teams ?? null,
    credentialsSaved: true,
  }),
);
