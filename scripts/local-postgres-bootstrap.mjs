import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { runDatabaseMigrations, DATABASE_MIGRATIONS } from "../src/lib/db/migrations.ts";
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), ssl: false, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 20000 };
const admin = new pg.Pool({ ...config, database: "postgres" }), pools = [];
const database = `codex_validation_bootstrap_${Date.now()}_${randomBytes(4).toString("hex")}`;
const unprotected = process.argv.includes("--unprotected");
try {
  const identity = (await admin.query("SELECT current_user AS actor, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416); assert.ok(identity.version >= 160000 && identity.version < 170000);
  assert.match(database, /^codex_validation_bootstrap_[0-9]+_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE "${database}"`);
  for (let i = 0; i < 3; i++) pools.push(new pg.Pool({ ...config, database }));
  const extract = async (file, name) => {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const match = source.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
    assert.ok(match); return match[1];
  };
  const schema = (await extract("../src/lib/db/schema.ts", "SCHEMA_SQL")).replace("${DISCUSSION_SCHEMA_SQL}", await extract("../src/lib/discussion-schema.ts", "DISCUSSION_SCHEMA_SQL"));
  process.env.DATABASE_URL = "local-validation-only"; process.env.INSTANCE_UNIX_SOCKET = "";
  const work = async pool => { await pool.query(schema); await runDatabaseMigrations(pool); };
  const protect = unprotected ? (_pool, operation) => operation() : (await import("../src/lib/db/bootstrap-lock.ts")).withDatabaseBootstrapLock;
  const appMode = process.argv.includes("--app");
  if (process.argv.includes("--seed-failure") || process.argv.includes("--seed-failure-late")) {
    const failureTable = process.argv.includes("--seed-failure-late") ? "reports" : "users";
    await work(pools[0]);
    await pools[0].query(`CREATE FUNCTION synthetic_seed_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$;
      CREATE TRIGGER synthetic_seed_failure BEFORE INSERT ON ${failureTable} FOR EACH ROW EXECUTE FUNCTION synthetic_seed_failure()`);
    const { runAppBootstrapRace } = await import("./local-postgres-app-race.mjs");
    await runAppBootstrapRace(config, database, "P0001");
    const counts = (await pools[0].query("SELECT (SELECT COUNT(*)::int FROM classes) AS classes, (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM teams) AS teams, (SELECT COUNT(*)::int FROM inquiry_cycles) AS cycles")).rows[0];
    assert.deepEqual(counts, { classes: 0, users: 0, teams: 0, cycles: 0 });
    await pools[0].query(`DROP TRIGGER synthetic_seed_failure ON ${failureTable}`);
    await runAppBootstrapRace(config, database);
    await writeFile(new URL(`postgres-seed-recovery-${failureTable}.json`, root), JSON.stringify({ database, postgresVersion: identity.version, failureTable, rolledBack: counts, recovered: true }, null, 2));
    console.log("Actual app seed interruption rolled back; three app processes recovered.");
  }
  const appResults = appMode ? await (await import("./local-postgres-app-race.mjs")).runAppBootstrapRace(config, database) : null;
  const results = await Promise.allSettled(pools.map(pool => protect(pool, () => work(pool))));
  const summary = { database, postgresVersion: identity.version, unprotected, appResults, outcomes: results.map(result => result.status === "fulfilled" ? "ok" : result.reason.code ?? result.reason.name) };
  if (!unprotected) {
    assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(summary));
    assert.deepEqual((await pools[0].query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(row => row.version), DATABASE_MIGRATIONS.map(migration => migration.version));
    // A failed initializer must release the session lock so another instance can retry.
    await assert.rejects(protect(pools[0], async () => { throw new Error("synthetic bootstrap interruption"); }), /synthetic bootstrap interruption/);
    await protect(pools[1], () => work(pools[1]));
    summary.retryAfterFailure = true;
  }
  await writeFile(new URL(unprotected ? "postgres-bootstrap-before.json" : "postgres-bootstrap-after.json", root), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally { await Promise.all(pools.map(pool => pool.end())); await admin.end(); }
