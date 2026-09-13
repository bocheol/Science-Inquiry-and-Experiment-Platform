import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createLocalTestDb } from "./local-postgres-test-env.mjs";

const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const password = (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim();
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password, ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 20000 };
globalThis.fetch = async () => { throw new Error("External network disabled"); };
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(stable(value)).digest("hex");

async function inventory(pool) {
  const result = { tables: {} };
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
    const rows = (await pool.query(`SELECT to_jsonb(t) AS row FROM public."${tablename}" t`)).rows.map(row => stable(row.row)).sort();
    result.tables[tablename] = { count: rows.length, hash: digest(rows) };
  }
  for (const [name, sql] of Object.entries({
    columns: "SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
    constraints: "SELECT rel.relname,c.conname,c.contype,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace WHERE n.nspname='public' ORDER BY rel.relname,c.conname",
    indexes: "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
  })) {
    const rows = (await pool.query(sql)).rows;
    result[name] = { count: rows.length, hash: digest(rows) };
  }
  return result;
}

if (process.argv.includes("--child")) {
  const [database, expectation] = process.argv.slice(-2);
  assert.match(database, /^codex_validation_compatibility(?:_sparse)?_[0-9]+_[a-f0-9]+$/);
  for (const name of ["INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "DATABASE_SSL", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SPREADSHEET_ID", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[name] = "";
  process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(password)}@127.0.0.1:55416/${database}?options=-c%20statement_timeout%3D20000`;
  process.env.NODE_ENV = "test";
  const { getDb } = await import("../src/lib/db/index.ts");
  if (expectation === "ok") {
    const app = await getDb();
    try { assert.equal((await app.query("SELECT current_database() AS name")).rows[0].name, database); }
    finally { await app.end(); }
  } else {
    assert.ok(["future", "changed"].includes(expectation));
    const errorPattern = expectation === "future" ? /지원하지 않는/ : /내용이 변경/;
    // The second call must retry and reject cleanly, with no cached failed pool.
    await assert.rejects(getDb(), errorPattern);
    await assert.rejects(getDb(), errorPattern);
    assert.equal(globalThis.__sciencePool, undefined);
    assert.equal(globalThis.__scienceDbReady, undefined);
  }
  console.log(`Child ${expectation} passed`);
} else {
  const { app, database, postgresVersion } = await createLocalTestDb("compatibility");
  let admin, sparse;
  const results = [];
  async function check(pool, name, databaseName, expectation) {
    const before = await inventory(pool);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-transform-types", "--import", "./scripts/local-review-test-loader.mjs", fileURLToPath(import.meta.url), "--child", databaseName, expectation], { env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Synthetic child failed (${code}): ${output}`)));
    });
    assert.deepEqual(await inventory(pool), before, `${name}: all table rows and schema must remain unchanged`);
    const client = await pool.connect();
    try {
      assert.equal((await client.query("SELECT pg_try_advisory_lock(4934051600002::bigint) AS locked")).rows[0].locked, true);
      await client.query("SELECT pg_advisory_unlock(4934051600002::bigint)");
    } finally { client.release(); }
    results.push({ name, expectation, unchanged: true, bootstrapLockReleased: true, inventory: before });
    console.log(`${name}: passed`);
  }
  try {
    const baseline = await inventory(app);
    await check(app, "compatible_before", database, "ok");
    await app.query("INSERT INTO schema_migrations(version,name,checksum) VALUES('9999','synthetic_future','synthetic')");
    await check(app, "future_full", database, "future");
    await app.query("DELETE FROM schema_migrations WHERE version='9999'");
    const original = (await app.query("SELECT name,checksum FROM schema_migrations WHERE version='0011'")).rows[0];
    await app.query("UPDATE schema_migrations SET checksum='synthetic_changed' WHERE version='0011'");
    await check(app, "checksum_changed", database, "changed");
    await app.query("UPDATE schema_migrations SET checksum=$1,name='synthetic_changed' WHERE version='0011'", [original.checksum]);
    await check(app, "name_changed", database, "changed");
    await app.query("UPDATE schema_migrations SET name=$1 WHERE version='0011'", [original.name]);
    await check(app, "compatible_after", database, "ok");
    assert.deepEqual(await inventory(app), baseline);
    admin = new pg.Pool({ ...config, database: "postgres" });
    const sparseName = `codex_validation_compatibility_sparse_${Date.now()}_${randomBytes(4).toString("hex")}`;
    assert.match(sparseName, /^codex_validation_compatibility_sparse_[0-9]+_[a-f0-9]+$/);
    await admin.query(`CREATE DATABASE "${sparseName}"`);
    sparse = new pg.Pool({ ...config, database: sparseName });
    await sparse.query("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL); INSERT INTO schema_migrations VALUES('9999','synthetic_future','synthetic')");
    await check(sparse, "future_before_baseline_and_seed", sparseName, "future");
    assert.deepEqual(Object.keys((await inventory(sparse)).tables), ["schema_migrations"]);
    await writeFile(new URL("postgres-compatibility-65.json", root), JSON.stringify({ database, sparseDatabase: sparseName, postgresVersion, baselinePreserved: true, results }, null, 2));
    console.log("All six actual PostgreSQL compatibility checks passed");
  } finally {
    await app.end();
    if (sparse) await sparse.end();
    if (admin) await admin.end();
  }
}
