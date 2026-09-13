// Read-only structural audit for the operational database after deployment.
// It reports aggregate counts only and never reads row content into the client.
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required.");

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 5_000 });
try {
  await pool.query("BEGIN READ ONLY");
  const version = await pool.query("SHOW server_version");
  assert.match(version.rows[0].server_version, /^16\./);
  const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(migrations.rows.map((row) => row.version), ["0001", "0002", "0003", "0004", "0005"]);
  const { rows } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM inquiry_sessions) AS sessions,
    (SELECT COUNT(*)::int FROM inquiry_cycles) AS cycles,
    (SELECT COUNT(*)::int FROM inquiry_cycles WHERE origin = 'legacy_unclassified') AS legacy_cycles,
    (SELECT COUNT(*)::int FROM investigation_plans WHERE cycle_id IS NULL) AS plans_without_cycle,
    (SELECT COUNT(*)::int FROM reports WHERE cycle_id IS NULL) AS reports_without_cycle,
    (SELECT COUNT(*)::int FROM material_requests WHERE cycle_id IS NULL) AS materials_without_cycle,
    (SELECT COUNT(*)::int FROM experiment_journals WHERE cycle_id IS NULL) AS journals_without_cycle,
    (SELECT COUNT(*)::int FROM messages WHERE cycle_id IS NULL) AS messages_without_cycle,
    (SELECT COUNT(*)::int FROM discussion_entries WHERE cycle_id IS NULL) AS discussions_without_cycle,
    (SELECT COUNT(*)::int FROM document_revisions WHERE cycle_id IS NULL) AS revisions_without_cycle,
    (SELECT COUNT(*)::int FROM investigation_plans p JOIN inquiry_cycles c ON c.id = p.cycle_id WHERE p.session_id <> c.session_id) AS plan_cycle_mismatch,
    (SELECT COUNT(*)::int FROM reports r JOIN inquiry_cycles c ON c.id = r.cycle_id WHERE r.session_id <> c.session_id) AS report_cycle_mismatch,
    (SELECT COUNT(*)::int FROM (
      SELECT cycle_id, student_id, session_number FROM experiment_journals
      GROUP BY cycle_id, student_id, session_number HAVING COUNT(*) > 1
    ) duplicates) AS duplicate_cycle_journals`);
  const state = rows[0];
  assert.ok(state.cycles >= state.sessions);
  for (const key of ["plans_without_cycle", "reports_without_cycle", "materials_without_cycle", "journals_without_cycle", "messages_without_cycle", "discussions_without_cycle", "revisions_without_cycle", "plan_cycle_mismatch", "report_cycle_mismatch", "duplicate_cycle_journals"]) {
    assert.equal(state[key], 0, `${key} must be zero`);
  }
  await pool.query("ROLLBACK");
  console.log(JSON.stringify({
    status: "passed",
    postgresMajor: 16,
    migrations: migrations.rows.length,
    sessions: state.sessions,
    cycles: state.cycles,
    legacyCycles: state.legacy_cycles,
    invalidLinks: 0,
    duplicateCycleJournals: 0,
  }));
} catch (error) {
  await pool.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
