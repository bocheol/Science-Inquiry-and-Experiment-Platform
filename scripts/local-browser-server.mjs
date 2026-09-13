// Serve a built standalone app against a fresh disposable local PostgreSQL DB.
// Run with --experimental-transform-types --import ./scripts/local-ts-loader.mjs.
import assert from "node:assert/strict";
import { readFile, writeFile, cp, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const server = new URL("../.next/standalone/server.js", import.meta.url);
await access(server);
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), ssl: false, connectionTimeoutMillis: 5000 };
for (const key of ["DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "NODE_OPTIONS"]) process.env[key] = "";
const database = `codex_validation_browser_${Date.now()}_${randomBytes(4).toString("hex")}`;
const admin = new pg.Pool({ ...config, database: "postgres" });
try {
  const identity = (await admin.query("SELECT current_user AS actor,host(inet_server_addr()) AS address,inet_server_port() AS port")).rows[0];
  assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416);
  assert.match(database, /^codex_validation_browser_[0-9]+_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE "${database}"`);
} finally { await admin.end(); }
process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(config.password)}@127.0.0.1:55416/${database}`;
process.env.NODE_ENV = "test";
process.env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-browser-only";
process.env.SESSION_SECRET = "synthetic-browser-session-only";
const { getDb } = await import("../src/lib/db/index.ts");
const app = await getDb(); await app.end();
await cp(new URL("../.next/static/", import.meta.url), new URL("../.next/standalone/.next/static/", import.meta.url), { recursive: true });
await cp(new URL("../public/", import.meta.url), new URL("../.next/standalone/public/", import.meta.url), { recursive: true });
await writeFile(new URL("local-browser-target.json", root), JSON.stringify({ database, base: "http://127.0.0.1:3108" }));
const child = spawn(process.execPath, [fileURLToPath(server)], { cwd: fileURLToPath(new URL("../.next/standalone/", import.meta.url)), env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: "3108", NEXT_TELEMETRY_DISABLED: "1" }, windowsHide: true, stdio: "inherit" });
await writeFile(new URL("local-browser-target.json", root), JSON.stringify({ database, base: "http://127.0.0.1:3108", helperPid: process.pid, serverPid: child.pid }));
process.once("SIGINT", () => child.kill()); process.once("SIGTERM", () => child.kill());
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
process.exitCode = code ?? 0;
