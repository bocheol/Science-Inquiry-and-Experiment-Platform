// Disposable, synthetic PostgreSQL only. Never reads DATABASE_URL or live credentials.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from "../src/lib/db/migrations.ts";

const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const password = (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim();
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password, ssl: false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000 };
const admin = new pg.Pool({ ...config, database: "postgres" });
const database = `codex_validation_${Date.now()}_${randomBytes(4).toString("hex")}`;
const pools = [];
try {
  const identity = (await admin.query("SELECT current_user AS actor, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416);
  assert.ok(identity.version >= 160000 && identity.version < 170000);
  assert.match(database, /^codex_validation_[0-9]+_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE "${database}"`);
  for (let i = 0; i < 3; i++) pools.push(new pg.Pool({ ...config, database }));
  const [db] = pools;
  const extract = async (file, name) => {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const match = source.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
    assert.ok(match, "bootstrap SQL found"); return match[1];
  };
  const schema = (await extract("../src/lib/db/schema.ts", "SCHEMA_SQL")).replace("${DISCUSSION_SCHEMA_SQL}", await extract("../src/lib/discussion-schema.ts", "DISCUSSION_SCHEMA_SQL"));
  // Migration locking checks only whether this marker is set. Connections above
  // remain explicit and local; external service credentials are never consumed.
  process.env.DATABASE_URL = "local-validation-only";
  process.env.INSTANCE_UNIX_SOCKET = "";
  await db.query(schema);
  await runDatabaseMigrations(db, DATABASE_MIGRATIONS.slice(0, 5));
  await db.query("INSERT INTO classes (id,academic_year,class_number,name) VALUES ('synthetic_class',2099,1,'합성 학급')");
  await db.query("INSERT INTO teams (id,class_id,team_number,name) VALUES ('synthetic_team','synthetic_class',1,'합성 팀')");
  await db.query("INSERT INTO inquiry_sessions (id,team_id) VALUES ('synthetic_session','synthetic_team')");
  await db.query("INSERT INTO inquiry_cycles (id,session_id,ordinal,title) VALUES ('synthetic_cycle','synthetic_session',1,'합성 회차')");
  await db.query("INSERT INTO reports (id,session_id,cycle_id,form_data,status) VALUES ('synthetic_report','synthetic_session','synthetic_cycle',$1,'reviewed')", [JSON.stringify({ analysis: "보존할 합성 원문" })]);
  const before = (await db.query("SELECT id,session_id,cycle_id,form_data,status,updated_at FROM reports WHERE id = 'synthetic_report'")).rows[0];
  await Promise.all(pools.map(pool => runDatabaseMigrations(pool)));
  const versions = (await db.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(row => row.version);
  assert.deepEqual(versions, DATABASE_MIGRATIONS.map(migration => migration.version));
  assert.deepEqual((await db.query("SELECT id,session_id,cycle_id,form_data,status,updated_at FROM reports WHERE id = 'synthetic_report'")).rows[0], before);
  assert.equal((await db.query("SELECT write_version FROM reports WHERE id = 'synthetic_report'")).rows[0].write_version, 0);
  const constraints = (await db.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname IN ('plan_ai_reviews_version_unique','cycle_ai_analyses_version_unique')")).rows;
  assert.equal(constraints.length, 2);
  for (const constraint of constraints) assert.match(constraint.definition, /prompt_version, schema_version/);
  const a = await db.connect(), b = await pools[1].connect();
  try {
    await a.query("BEGIN"); await a.query("SELECT id FROM reports WHERE id = 'synthetic_report' FOR UPDATE");
    const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pending = b.query("UPDATE reports SET write_version = write_version + 1 WHERE id = 'synthetic_report'");
    let blocked = false;
    for (let i = 0; i < 40; i++) {
      const state = (await pools[2].query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0];
      if (state?.wait_event_type === "Lock") { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(blocked, "independent PostgreSQL connection really waited for the row lock");
    await a.query("COMMIT"); await pending;
    await a.query("BEGIN"); await a.query("UPDATE reports SET write_version = 99 WHERE id = 'synthetic_report'"); await a.query("ROLLBACK");
    assert.equal((await db.query("SELECT write_version FROM reports WHERE id = 'synthetic_report'")).rows[0].write_version, 1);
  } finally { await a.query("ROLLBACK").catch(() => undefined); a.release(); b.release(); }
  const result = { database, postgresVersion: identity.version, migrations: versions, preservedReport: true, versionConstraints: constraints.length, observedRealRowLock: true, rollbackVerified: true };
  await writeFile(new URL("postgres-smoke-result.json", root), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await Promise.all(pools.map(pool => pool.end())); await admin.end();
}
