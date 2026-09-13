import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultDatabaseUrl = "postgresql://science_dev:science_dev_only@db:5432/science_dev";
const externalKeys = [
  "DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
  "SUMMARY_SCHEDULER_AUDIENCE", "SUMMARY_SCHEDULER_EMAIL", "SESSION_SECRET",
  "BOOTSTRAP_TEACHER_LOGIN", "BOOTSTRAP_TEACHER_PASSWORD", "SCIENCE_DEV_ALLOWED_ORIGIN",
];

export function validateDevelopmentDatabase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("개발 DB 주소 형식이 잘못됐습니다."); }
  if (url.protocol !== "postgresql:" || !["db", "127.0.0.1", "localhost"].includes(url.hostname)
    || url.username !== "science_dev" || url.password !== "science_dev_only"
    || url.pathname !== "/science_dev" || url.search || url.hash) {
    throw new Error("개발 전용 PostgreSQL만 연결할 수 있습니다. 운영 DB 주소는 사용할 수 없습니다.");
  }
  return url.toString();
}

export function safeEnvironment(base = process.env, options = {}) {
  const env = { ...base };
  // Explicit empty values outrank Next's .env files. Do not print their contents.
  const fileKeys = options.envKeys ?? readdirSync(root)
    .filter((name) => /^\.env(?:\.|$)/.test(name) && name !== ".env.example")
    .flatMap((name) => [...readFileSync(join(root, name), "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]));
  for (const key of new Set([...externalKeys, ...fileKeys, ...Object.keys(env).filter((key) => /^(GOOGLE_|GCLOUD_|CLOUDSDK_|PG|DB_|OPENAI_|VAPID_|NEXT_PUBLIC_)/.test(key))])) env[key] = "";
  env.ACADEMIC_YEAR = "2026";
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.DATABASE_SSL = "false";
  env.SESSION_SECRET = options.sessionSecret || "synthetic-verification-session-secret-only";
  env.BOOTSTRAP_TEACHER_LOGIN = "teacher2";
  env.BOOTSTRAP_TEACHER_PASSWORD = "development-teacher-only";
  env.NODE_ENV = options.nodeEnv || "development";
  if (options.databaseUrl) env.DATABASE_URL = validateDevelopmentDatabase(options.databaseUrl);
  if (base.CODESPACES === "true" && base.CODESPACE_NAME) {
    const domain = base.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev";
    if (!/^[a-z0-9-]+$/.test(base.CODESPACE_NAME) || !/^[a-z0-9.-]+$/.test(domain)) throw new Error("Codespaces 주소를 확인할 수 없습니다.");
    env.SCIENCE_DEV_ALLOWED_ORIGIN = `${base.CODESPACE_NAME}-3000.${domain}`;
  }
  // A separate, deliberately named Codespaces secret opts into live AI.
  // Verification never uses it. Production Google/DB/push credentials stay disabled.
  if (options.allowAi && base.SCIENCE_DEV_OPENAI_API_KEY) env.OPENAI_API_KEY = base.SCIENCE_DEV_OPENAI_API_KEY;
  env.SCIENCE_DEV_OPENAI_API_KEY = "";
  return env;
}

function sessionSecret() {
  const directory = join(root, ".science-dev");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("개발 설정 경로가 올바르지 않습니다.");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session-secret");
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  if (lstatSync(path).isSymbolicLink()) throw new Error("개발 설정 파일이 올바르지 않습니다.");
  const value = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("개발 세션 설정을 확인해 주세요.");
  return value;
}

export function runNode(script, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: "inherit" });
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGTERM", interrupt);
    child.once("error", reject);
    child.once("exit", (code) => {
      process.removeListener("SIGTERM", interrupt);
      code === 0 ? resolveRun() : reject(new Error(`검증/실행 실패 (exit ${code ?? "signal"})`));
    });
  });
}

async function main() {
  const command = process.argv[2];
  const isCloud = process.env.SCIENCE_CLOUD_DEV === "1" || process.env.CODESPACES === "true";
  const next = join(root, "node_modules/next/dist/bin/next");
  if (command === "dev" && !isCloud) {
    await runNode(next, ["dev", ...process.argv.slice(3)], process.env);
    return;
  }
  if (command === "check") {
    const env = safeEnvironment(process.env, { nodeEnv: "test" });
    await runNode(join(root, "scripts/cloud-dev.test.mjs"), [], env);
    await runNode(join(root, "node_modules/vitest/vitest.mjs"), ["run", "--maxWorkers=1"], env);
    await runNode(next, ["build"], { ...env, NODE_ENV: "production" });
    await runNode(join(root, "node_modules/typescript/bin/tsc"), ["--noEmit"], env);
    return;
  }
  if (!["setup", "dev", "status"].includes(command) || !isCloud) throw new Error("개발 컨테이너에서 cloud:setup 또는 pnpm dev를 실행해 주세요.");
  const env = safeEnvironment(process.env, {
    databaseUrl: process.env.SCIENCE_DEV_DATABASE_URL || defaultDatabaseUrl,
    sessionSecret: sessionSecret(), allowAi: command === "dev",
  });
  const { default: pg } = await import("pg");
  const db = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: false, connectionTimeoutMillis: 10000 });
  try {
    const { rows: [identity] } = await db.query("SELECT current_database() AS name, current_user AS actor, current_setting('server_version_num')::int AS version");
    if (identity.name !== "science_dev" || identity.actor !== "science_dev" || identity.version < 160000 || identity.version >= 170000) throw new Error("개발 DB의 이름·계정·버전이 맞지 않습니다.");
    console.log("개발 PostgreSQL 16 연결 확인. 운영 DB·Google Sheets·푸시 연결 없음.");
  } finally { await db.end(); }
  if (command === "setup") {
    await runNode("--experimental-transform-types", ["--import", pathToFileURL(join(root, "scripts/local-ts-loader.mjs")).href, join(root, "scripts/cloud-bootstrap.mjs")], env);
  }
  if (command === "dev") {
    console.log(`개발 미리보기 시작. 실제 AI: ${env.OPENAI_API_KEY ? "사용" : "꺼짐"}.`);
    await runNode(next, ["dev", "--hostname", "0.0.0.0", "--port", "3000", ...process.argv.slice(3)], env);
  } else console.log("준비 완료. pnpm dev를 실행하고 Ports의 3000번 미리보기를 여세요. 공개 범위는 Private를 유지하세요.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
