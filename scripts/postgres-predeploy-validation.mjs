// Run only against a disposable PostgreSQL 16 database restored from an
// operational backup. The script prints counts and digests, never row content.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { runDatabaseMigrations } from "../src/lib/db/migrations.ts";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL must point to the disposable restored database.");

async function currentBootstrapSql() {
  const [schemaSource, discussionSource] = await Promise.all([
    readFile(new URL("../src/lib/db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/discussion-schema.ts", import.meta.url), "utf8"),
  ]);
  const extract = (source, name) => {
    const match = source.match(new RegExp("export const " + name + " = `([\\s\\S]*?)`;"));
    if (!match) throw new Error(`${name} SQL을 읽지 못했습니다.`);
    return match[1];
  };
  return extract(schemaSource, "SCHEMA_SQL").replace("${DISCUSSION_SCHEMA_SQL}", extract(discussionSource, "DISCUSSION_SCHEMA_SQL"));
}

const trackedQueries = {
  users: `SELECT id, concat_ws(chr(31), id, login_id, academic_year::text, role, COALESCE(class_id,''),
    password_hash, must_change_password::text, account_type, is_master::text, status, created_at::text) AS value FROM users`,
  teams: `SELECT id, concat_ws(chr(31), id, COALESCE(class_id,''), COALESCE(club_id,''), team_number::text,
    name, COALESCE(leader_user_id,''), status, COALESCE(archived_at::text,''), COALESCE(archived_by,''), created_at::text) AS value FROM teams`,
  team_members: `SELECT id, concat_ws(chr(31), id, team_id, user_id, joined_at::text,
    COALESCE(left_at::text,''), status) AS value FROM team_members`,
  inquiry_sessions: `SELECT id, concat_ws(chr(31), id, team_id, COALESCE(interest_input,''), COALESCE(selected_topic,''),
    stage, conversation_summary, ai_topic_suggestions::text, started_at::text, last_activity_at::text) AS value FROM inquiry_sessions`,
  investigation_plans: `SELECT id, concat_ws(chr(31), id, session_id, form_data::text, review_status,
    COALESCE(teacher_feedback,''), COALESCE(reviewed_by,''), COALESCE(config_version_id,''), created_at::text, updated_at::text) AS value FROM investigation_plans`,
  reports: `SELECT id, concat_ws(chr(31), id, session_id, form_data::text, status, COALESCE(teacher_feedback,''),
    COALESCE(reviewed_by,''), COALESCE(submitted_at::text,''), COALESCE(config_version_id,''), created_at::text, updated_at::text) AS value FROM reports`,
  material_requests: `SELECT id, concat_ws(chr(31), id, submission_id, session_id, team_id, submitted_by,
    form_data::text, total_amount::text, budget_status, sync_status, COALESCE(sync_error,''), submitted_at::text,
    COALESCE(synced_at::text,'')) AS value FROM material_requests`,
  experiment_journals: `SELECT id, concat_ws(chr(31), id, session_id, student_id, session_number::text,
    journal_date::text, activities, observations, reflections, created_at::text, updated_at::text) AS value FROM experiment_journals`,
  messages: `SELECT id, concat_ws(chr(31), id, session_id, COALESCE(sender_id,''), COALESCE(sender_alias,''),
    role, content, sequence::text, citations::text, created_at::text) AS value FROM messages`,
  discussion_entries: `SELECT id, concat_ws(chr(31), id, session_id, author_id, kind, activity_date, content,
    participants::text, COALESCE(parent_id,''), created_at::text) AS value FROM discussion_entries`,
};

async function fingerprints(pool) {
  const result = {};
  for (const [name, query] of Object.entries(trackedQueries)) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count,
      md5(COALESCE(string_agg(md5(value), '' ORDER BY id), '')) AS digest FROM (${query}) source`);
    result[name] = rows[0];
  }
  return result;
}

function newPool() {
  return new Pool({ connectionString, max: 4, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 10_000 });
}

async function assertMigrationShape(pool, before) {
  const versions = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(versions.rows.map((row) => row.version), ["0001", "0002", "0003", "0004", "0005"]);

  const checks = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM inquiry_sessions) AS sessions,
    (SELECT COUNT(*)::int FROM inquiry_cycles) AS cycles,
    (SELECT COUNT(*)::int FROM inquiry_cycles WHERE ordinal = 1 AND origin = 'legacy_unclassified' AND status = 'active') AS legacy_cycles,
    (SELECT COUNT(*)::int FROM investigation_plans WHERE cycle_id IS NULL) AS plans_without_cycle,
    (SELECT COUNT(*)::int FROM reports WHERE cycle_id IS NULL) AS reports_without_cycle,
    (SELECT COUNT(*)::int FROM material_requests WHERE cycle_id IS NULL) AS materials_without_cycle,
    (SELECT COUNT(*)::int FROM experiment_journals WHERE cycle_id IS NULL) AS journals_without_cycle,
    (SELECT COUNT(*)::int FROM messages WHERE cycle_id IS NULL) AS messages_without_cycle,
    (SELECT COUNT(*)::int FROM discussion_entries WHERE cycle_id IS NULL) AS discussions_without_cycle,
    (SELECT COUNT(*)::int FROM investigation_plans p JOIN inquiry_cycles c ON c.id = p.cycle_id WHERE p.session_id <> c.session_id) AS plan_cycle_mismatch,
    (SELECT COUNT(*)::int FROM reports r JOIN inquiry_cycles c ON c.id = r.cycle_id WHERE r.session_id <> c.session_id) AS report_cycle_mismatch`);
  const row = checks.rows[0];
  assert.equal(row.cycles, row.sessions);
  assert.equal(row.legacy_cycles, row.sessions);
  for (const key of ["plans_without_cycle", "reports_without_cycle", "materials_without_cycle", "journals_without_cycle", "messages_without_cycle", "discussions_without_cycle", "plan_cycle_mismatch", "report_cycle_mismatch"]) {
    assert.equal(row[key], 0, `${key} must be zero`);
  }

  const after = await fingerprints(pool);
  assert.deepEqual(after, before, "migration changed protected row counts or content digests");
  return { versions: versions.rows.length, sessions: row.sessions, protectedTables: Object.keys(after).length };
}

async function transitionRace(pool) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const classId = `verify_class_${suffix}`;
  const teacherId = `verify_teacher_${suffix}`;
  const teamId = `verify_team_${suffix}`;
  const sessionId = `verify_session_${suffix}`;
  const cycleId = `verify_cycle_${suffix}_1`;
  const academicYear = 5000 + (Date.now() % 1000000);
  await pool.query("INSERT INTO classes (id, academic_year, class_number, name) VALUES ($1,$2,99,'검증 전용')", [classId, academicYear]);
  await pool.query(`INSERT INTO users
    (id, name, login_id, academic_year, role, class_id, password_hash, must_change_password, status)
    VALUES ($1, '검증 교사', $2, $3, 'teacher', NULL, 'not-a-login-secret', FALSE, 'active')`, [teacherId, `verify_${suffix}`, academicYear]);
  await pool.query("INSERT INTO teams (id, class_id, team_number, name, status) VALUES ($1,$2,99,'검증 전용 팀','active')", [teamId, classId]);
  await pool.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ($1,$2)", [sessionId, teamId]);
  await pool.query(`INSERT INTO inquiry_cycles
    (id, session_id, ordinal, title, status, origin, started_at, created_by)
    VALUES ($1,$2,1,'검증 1차','active','configured',CURRENT_TIMESTAMP,$3)`, [cycleId, sessionId, teacherId]);

  async function attempt(label) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM inquiry_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      const current = await client.query("SELECT status FROM inquiry_cycles WHERE id = $1 FOR UPDATE", [cycleId]);
      if (current.rows[0]?.status !== "active") throw new Error(`${label}:stale-cycle`);
      await client.query("UPDATE inquiry_cycles SET status = 'completed', ended_at = CURRENT_TIMESTAMP WHERE id = $1", [cycleId]);
      await client.query(`INSERT INTO inquiry_cycles
        (id, session_id, ordinal, title, status, origin, started_at, created_by)
        VALUES ($1,$2,2,'검증 2차','active','configured',CURRENT_TIMESTAMP,$3)`, [`verify_cycle_${suffix}_2`, sessionId, teacherId]);
      await client.query("COMMIT");
      return "committed";
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message.endsWith(":stale-cycle")) return "rejected-stale";
      throw error;
    } finally {
      client.release();
    }
  }

  const outcomes = await Promise.all([attempt("a"), attempt("b")]);
  assert.deepEqual([...outcomes].sort(), ["committed", "rejected-stale"]);
  const state = await pool.query("SELECT ordinal, status FROM inquiry_cycles WHERE session_id = $1 ORDER BY ordinal", [sessionId]);
  assert.deepEqual(state.rows, [{ ordinal: 1, status: "completed" }, { ordinal: 2, status: "active" }]);
  const staleWrite = await pool.query("UPDATE inquiry_cycles SET title = title WHERE id = $1 AND status = 'active' RETURNING id", [cycleId]);
  assert.equal(staleWrite.rowCount, 0);
  await pool.query("DELETE FROM inquiry_cycles WHERE session_id = $1", [sessionId]);
  await pool.query("DELETE FROM inquiry_sessions WHERE id = $1", [sessionId]);
  await pool.query("DELETE FROM teams WHERE id = $1", [teamId]);
  await pool.query("DELETE FROM users WHERE id = $1", [teacherId]);
  await pool.query("DELETE FROM classes WHERE id = $1", [classId]);
  return { concurrentRequests: outcomes.length, committed: 1, staleRejected: 1 };
}

const pool = newPool();
try {
  const version = await pool.query("SHOW server_version");
  assert.match(version.rows[0].server_version, /^16\./);
  const before = await fingerprints(pool);
  const bootstrapSql = await currentBootstrapSql();
  const migrationPools = [newPool(), newPool(), newPool()];
  try {
    await Promise.all(migrationPools.map(async (candidate) => {
      await candidate.query(bootstrapSql);
      await runDatabaseMigrations(candidate);
    }));
  } finally {
    await Promise.all(migrationPools.map((candidate) => candidate.end()));
  }
  await runDatabaseMigrations(pool);
  const migration = await assertMigrationShape(pool, before);
  const concurrency = await transitionRace(pool);
  console.log(JSON.stringify({ status: "passed", postgresMajor: 16, migration, concurrency }));
} finally {
  await pool.end();
}
