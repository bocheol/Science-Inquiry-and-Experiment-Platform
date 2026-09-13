// Synthetic AI leases only; no model, student, Sheets or push calls.
// Run with --experimental-transform-types --import ./scripts/local-ts-loader.mjs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
const root = new URL("../output/test-infra/", import.meta.url);
assert.equal(await readFile(new URL("local-postgres-marker.txt", root), "utf8"), "science-inquiry-disposable-postgres16");
const config = { host: "127.0.0.1", port: 55416, user: "codex_local", password: (await readFile(new URL("local-postgres-password.txt", root), "utf8")).trim(), ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 20000 };
for (const key of ["DATABASE_URL", "DATABASE_SSL", "INSTANCE_UNIX_SOCKET", "DB_USER", "DB_PASSWORD", "DB_NAME", "OPENAI_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_SPREADSHEET_ID", "K_SERVICE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) process.env[key] = "";
const database = `codex_validation_ai_${Date.now()}_${randomBytes(4).toString("hex")}`;
const admin = new pg.Pool({ ...config, database: "postgres" });
let app, observer;
const results = [], reproduce = process.argv.includes("--reproduce");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
try {
  const identity = (await admin.query("SELECT current_user AS actor, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(identity.actor, "codex_local"); assert.equal(identity.address, "127.0.0.1"); assert.equal(identity.port, 55416); assert.ok(identity.version >= 160000 && identity.version < 170000);
  assert.match(database, /^codex_validation_ai_[0-9]+_[a-f0-9]+$/);
  await admin.query(`CREATE DATABASE "${database}"`);
  process.env.DATABASE_URL = `postgresql://codex_local:${encodeURIComponent(config.password)}@127.0.0.1:55416/${database}?options=-c%20statement_timeout%3D20000`;
  process.env.NODE_ENV = "test"; process.env.BOOTSTRAP_TEACHER_PASSWORD = "synthetic-ai-race-only";
  const { getDb } = await import("../src/lib/db/index.ts");
  const { beginAiJob, runAiJobStep, completeAiJob } = await import("../src/lib/ai-jobs.ts");
  app = await getDb(); observer = new pg.Pool({ ...config, database });
  const nativeConnect = app.connect.bind(app);
  let gate = null;
  app.connect = (...args) => args.length ? nativeConnect(...args) : (async () => {
    const client = await nativeConnect(), query = client.query.bind(client), release = client.release.bind(client);
    client.query = async (...queryArgs) => {
      if (gate && !gate.used && String(queryArgs[0]).includes("INSERT INTO ai_generation_job_steps")) {
        const current = gate; current.used = true; current.pid = client.processID; current.ready.resolve();
        await current.resume.promise;
        if (current.fail) throw new Error("synthetic step write interruption");
      }
      return query(...queryArgs);
    };
    client.release = (...releaseArgs) => { client.query = query; return release(...releaseArgs); };
    return client;
  })();
  async function waitBlocked(pid) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND $2::int=ANY(pg_blocking_pids(pid))", [database, pid])).rows.length) return;
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error("Takeover did not wait on the step writer");
  }
  const start = new Date("2026-09-08T01:00:00Z");
  if (!reproduce) {
    for (const differentRequest of [false, true]) {
      const resourceKey = `synthetic:first-acquire:${differentRequest}`;
      const attempts = await Promise.all([0, 1, 2].map(index => beginAiJob({ resourceKey, requestKey: differentRequest ? `request-${index}` : "same-request", feature: "synthetic-first-acquire", actorId: "teacher_bootstrap", now: start })));
      assert.equal(attempts.filter(item => item.kind === "acquired").length, 1);
      assert.equal(attempts.filter(item => item.kind === "busy").length, 2);
      assert.equal((await app.query("SELECT id FROM ai_generation_jobs WHERE resource_key=$1 AND status='processing'", [resourceKey])).rows.length, 1);
      results.push({ differentRequest, scenario: "three_initial_requests", acquired: 1, busy: 2 });
      console.log(`${differentRequest ? "different" : "same"} request / three initial requests: passed`);
    }
  }
  for (const differentRequest of [false, true]) {
    for (const scenario of ["takeover_first", "writer_first", "writer_failure"]) {
      if (reproduce && scenario === "writer_failure") continue;
      const resourceKey = `synthetic:${differentRequest}:${scenario}`;
      const acquire = (requestKey, now) => beginAiJob({ resourceKey, requestKey, feature: "synthetic-lease-race", actorId: "teacher_bootstrap", leaseMs: 1000, now });
      const old = await acquire("original", start); assert.equal(old.kind, "acquired");
      let replacement, oldResult;
      if (scenario === "takeover_first") {
        const generation = deferred(), generated = deferred();
        const writing = settle(runAiJobStep(old, "step", async () => { generated.resolve(); await generation.promise; return { source: "obsolete" }; }));
        await generated.promise;
        try { replacement = await acquire(differentRequest ? "replacement" : "original", new Date(start.getTime() + 1001)); }
        finally { generation.resolve(); }
        assert.equal(replacement.kind, "acquired"); oldResult = await writing;
        if (!reproduce || !differentRequest) {
          assert.equal(oldResult.ok, false, "Old generation must lose write permission after takeover");
          assert.match(oldResult.error.message, /소유권/);
          assert.equal((await app.query("SELECT 1 FROM ai_generation_job_steps WHERE job_id=$1", [old.jobId])).rows.length, 0);
        } else assert.equal(oldResult.ok, true, "Pre-fix different-request owner remains incorrectly active");
      } else {
        gate = { ready: deferred(), resume: deferred(), used: false, pid: null, fail: scenario === "writer_failure" };
        const current = gate, writing = settle(runAiJobStep(old, "step", async () => ({ source: "original" })));
        const timer = setTimeout(current.resume.resolve, 12000);
        let taking;
        try {
          await Promise.race([current.ready.promise, writing.then(result => { throw result.error ?? new Error("Step finished before pause"); })]);
          taking = settle(acquire(differentRequest ? "replacement" : "original", new Date(start.getTime() + 1001)));
          if (reproduce) { const taken = await taking; assert.equal(taken.ok, true); replacement = taken.value; }
          else await Promise.race([waitBlocked(current.pid), taking.then(() => { throw new Error("Takeover completed before writer released its lock"); })]);
        } finally { clearTimeout(timer); current.resume.resolve(); }
        oldResult = await writing;
        const taken = await taking; assert.equal(taken.ok, true, taken.error?.message); replacement = taken.value;
        assert.equal(replacement.kind, "acquired"); assert.equal(oldResult.ok, scenario !== "writer_failure", oldResult.error?.message);
        gate = null;
      }
      let calls = 0;
      const currentStep = await runAiJobStep(replacement, "step", async () => { calls++; return { source: "replacement" }; });
      const reuse = !differentRequest && scenario === "writer_first";
      assert.deepEqual(currentStep, { source: reuse ? "original" : "replacement" });
      assert.equal(calls, reuse ? 0 : 1);
      assert.equal(await completeAiJob(app, old.jobId, old.leaseToken, { obsolete: true }), reproduce && differentRequest);
      assert.equal(await completeAiJob(app, replacement.jobId, replacement.leaseToken, { current: true }), true);
      results.push({ differentRequest, scenario, reproduced: reproduce, writerAccepted: oldResult.ok, reusedStep: reuse });
      console.log(`${differentRequest ? "different" : "same"} request / ${scenario}: ${reproduce ? "pre-fix behavior verified" : "passed"}`);
    }
  }
  await writeFile(new URL(reproduce ? "postgres-ai-race-before.json" : "postgres-ai-race-after.json", root), JSON.stringify({ database, postgresVersion: identity.version, results }, null, 2));
} finally { await app?.end(); await observer?.end(); await admin.end(); }
