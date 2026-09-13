import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
export async function createLocalTestDb(label) {
  assert.match(label, /^[a-z_]+$/);
  const root = new URL("../output/test-infra/", import.meta.url);
  assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
  const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 20000 };
  for (const key of ["DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[key] = "";
  const database = `codex_validation_${label}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Pool({ ...config, database: "postgres" });
  let identity;
  try {
    identity = (await admin.query("SELECT current_user AS actor,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('server_version_num')::int AS version")).rows[0];
    assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416); assert.ok(identity.version >= 160000 && identity.version < 170000);
    assert.match(database, /^codex_validation_[a-z_]+_[0-9]+_[a-f0-9]+$/);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally { await admin.end(); }
  process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(config.password)}@127.0.0.1:55416/${database}?options=-c%20statement_timeout%3D20000`;
  process.env.NODE_ENV = "test"; process.env.ACADEMIC_YEAR = "2026"; process.env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-local-test-only";
  assert.equal(globalThis.__sciencePool, undefined, "Use a fresh test process");
  const { getDb } = await import("../src/lib/db/index.ts");
  const app = await getDb();
  return { root, database, postgresVersion: identity.version, app };
}
