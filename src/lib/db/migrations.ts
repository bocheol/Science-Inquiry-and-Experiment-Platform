import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type DatabaseMigration = {
  version: string;
  name: string;
  sql: string;
};

// SCHEMA_SQL remains the safe bootstrap for new installations. Numbered
// migrations form the forward-only boundary for changes added after it.
export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: "0001",
    name: "current_schema_baseline",
    // SCHEMA_SQL still applies the existing schema before this marker. New
    // forward changes start at 0002 and belong in a numbered migration.
    sql: "SELECT 1",
  },
  {
    version: "0002",
    name: "session_invalidation_and_login_throttling",
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0);

      CREATE TABLE login_attempt_buckets (
        bucket_key TEXT PRIMARY KEY,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        window_started_at TIMESTAMPTZ NOT NULL,
        blocked_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: "0003",
    name: "recoverable_ai_generation_jobs",
    sql: `
      CREATE TABLE ai_generation_resources (
        resource_key TEXT PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE ai_generation_jobs (
        id TEXT PRIMARY KEY,
        resource_key TEXT NOT NULL REFERENCES ai_generation_resources(resource_key) ON DELETE CASCADE,
        request_key TEXT NOT NULL,
        feature TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        lease_token TEXT,
        lease_until TIMESTAMPTZ,
        result_json JSONB,
        attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
        created_by TEXT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (resource_key, request_key)
      );

      CREATE TABLE ai_generation_job_steps (
        job_id TEXT NOT NULL REFERENCES ai_generation_jobs(id) ON DELETE CASCADE,
        step_key TEXT NOT NULL,
        result_json JSONB NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (job_id, step_key)
      );

      CREATE INDEX idx_ai_generation_jobs_resource
        ON ai_generation_jobs(resource_key, status, lease_until);

      UPDATE inquiry_sessions SET ai_busy = FALSE WHERE ai_busy = TRUE;
    `,
  },
  {
    version: "0004",
    name: "inquiry_cycles_plan_snapshots_and_ai_reviews",
    sql: `
      CREATE TABLE inquiry_cycles (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES inquiry_sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
        origin TEXT NOT NULL DEFAULT 'configured' CHECK (origin IN ('configured', 'legacy_unclassified')),
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        created_by TEXT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, ordinal)
      );

      CREATE INDEX idx_inquiry_cycles_session_status
        ON inquiry_cycles(session_id, status, ordinal);

      INSERT INTO inquiry_cycles (id, session_id, ordinal, title, status, origin, started_at)
      SELECT 'cycle_' || id || '_1', id, 1, '기존 탐구 자료', 'active', 'legacy_unclassified', NULL
        FROM inquiry_sessions
      ON CONFLICT (session_id, ordinal) DO NOTHING;

      ALTER TABLE investigation_plans
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);
      ALTER TABLE reports
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);
      ALTER TABLE material_requests
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);
      ALTER TABLE experiment_journals
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);

      UPDATE investigation_plans
         SET cycle_id = 'cycle_' || session_id || '_1'
       WHERE cycle_id IS NULL;
      UPDATE reports
         SET cycle_id = 'cycle_' || session_id || '_1'
       WHERE cycle_id IS NULL;
      UPDATE material_requests
         SET cycle_id = 'cycle_' || session_id || '_1'
       WHERE cycle_id IS NULL;
      UPDATE experiment_journals
         SET cycle_id = 'cycle_' || session_id || '_1'
       WHERE cycle_id IS NULL;

      CREATE TABLE plan_document_snapshots (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES investigation_plans(id) ON DELETE CASCADE,
        cycle_id TEXT REFERENCES inquiry_cycles(id),
        cycle_definition JSONB NOT NULL,
        form_data JSONB NOT NULL,
        config_version_id TEXT REFERENCES club_config_versions(id),
        config_definition JSONB NOT NULL,
        document_updated_at TIMESTAMPTZ NOT NULL,
        content_hash TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plan_id, content_hash)
      );

      CREATE TABLE plan_submissions (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES investigation_plans(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL REFERENCES plan_document_snapshots(id),
        cycle_id TEXT REFERENCES inquiry_cycles(id),
        submission_number INTEGER NOT NULL CHECK (submission_number > 0),
        source TEXT NOT NULL DEFAULT 'submission' CHECK (source IN ('submission', 'legacy_capture')),
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'feedback', 'approved', 'withdrawn')),
        teacher_feedback TEXT,
        reviewed_by TEXT REFERENCES users(id),
        reviewed_at TIMESTAMPTZ,
        submitted_by TEXT NOT NULL REFERENCES users(id),
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plan_id, submission_number)
      );

      CREATE INDEX idx_plan_submissions_plan_latest
        ON plan_submissions(plan_id, submission_number);

      CREATE TABLE plan_ai_reviews (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES plan_document_snapshots(id) ON DELETE CASCADE,
        submission_id TEXT REFERENCES plan_submissions(id) ON DELETE CASCADE,
        audience TEXT NOT NULL CHECK (audience IN ('student', 'teacher')),
        requested_by TEXT NOT NULL REFERENCES users(id),
        ai_job_id TEXT NOT NULL REFERENCES ai_generation_jobs(id),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        result_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (snapshot_id, audience)
      );

      CREATE INDEX idx_plan_ai_reviews_snapshot_audience
        ON plan_ai_reviews(snapshot_id, audience);
    `,
  },
  {
    version: "0005",
    name: "multi_cycle_evidence_analysis_and_decisions",
    sql: `
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);
      ALTER TABLE discussion_entries
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);
      ALTER TABLE document_revisions
        ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES inquiry_cycles(id);

      UPDATE messages
         SET cycle_id = 'cycle_' || session_id || '_1'
       WHERE cycle_id IS NULL;
      UPDATE discussion_entries
         SET cycle_id = 'cycle_' || session_id || '_1'
       WHERE cycle_id IS NULL;
      UPDATE document_revisions
         SET cycle_id = investigation_plans.cycle_id
        FROM investigation_plans
       WHERE document_revisions.cycle_id IS NULL
         AND document_revisions.document_type = 'plan'
         AND investigation_plans.id = document_revisions.document_id;
      UPDATE document_revisions
         SET cycle_id = reports.cycle_id
        FROM reports
       WHERE document_revisions.cycle_id IS NULL
         AND document_revisions.document_type = 'report'
         AND reports.id = document_revisions.document_id;

      ALTER TABLE experiment_journals
        DROP CONSTRAINT IF EXISTS experiment_journals_session_id_student_id_session_number_key;
      ALTER TABLE experiment_journals
        ADD CONSTRAINT experiment_journals_cycle_student_number_key
        UNIQUE (cycle_id, student_id, session_number);

      CREATE TABLE cycle_evidence_snapshots (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES inquiry_cycles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES inquiry_sessions(id) ON DELETE CASCADE,
        cycle_definition JSONB NOT NULL,
        plan_snapshot_id TEXT NOT NULL REFERENCES plan_document_snapshots(id),
        report_definition JSONB NOT NULL,
        report_form_data JSONB NOT NULL,
        report_member_roles JSONB NOT NULL,
        material_requests JSONB NOT NULL,
        journals JSONB NOT NULL,
        messages JSONB NOT NULL,
        discussion_summaries JSONB NOT NULL,
        trajectory_context JSONB NOT NULL,
        content_hash TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (cycle_id, content_hash)
      );

      CREATE INDEX idx_cycle_evidence_snapshots_cycle
        ON cycle_evidence_snapshots(cycle_id, created_at DESC);

      CREATE TABLE cycle_ai_analyses (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES inquiry_cycles(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL REFERENCES cycle_evidence_snapshots(id) ON DELETE CASCADE,
        analysis_type TEXT NOT NULL CHECK (analysis_type IN ('intermediate', 'final')),
        requested_by TEXT NOT NULL REFERENCES users(id),
        ai_job_id TEXT NOT NULL REFERENCES ai_generation_jobs(id),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        result_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (snapshot_id, analysis_type)
      );

      CREATE INDEX idx_cycle_ai_analyses_cycle
        ON cycle_ai_analyses(cycle_id, created_at DESC);

      CREATE TABLE cycle_ai_decisions (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL REFERENCES cycle_ai_analyses(id) ON DELETE CASCADE,
        suggestion_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'modified', 'rejected')),
        reason TEXT NOT NULL,
        write_version INTEGER NOT NULL DEFAULT 1 CHECK (write_version > 0),
        created_by TEXT NOT NULL REFERENCES users(id),
        updated_by TEXT NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (analysis_id, suggestion_id)
      );

      CREATE INDEX idx_cycle_ai_decisions_analysis
        ON cycle_ai_decisions(analysis_id, suggestion_id);

      CREATE INDEX idx_document_revisions_cycle
        ON document_revisions(document_type, document_id, cycle_id, created_at DESC);
    `,
  },
  {
    version: "0006",
    name: "report_review_write_version",
    sql: `ALTER TABLE reports ADD COLUMN IF NOT EXISTS write_version INTEGER NOT NULL DEFAULT 0;
          UPDATE reports SET write_version = COALESCE(write_version, 0);`,
  },
  {
    version: "0007",
    name: "versioned_ai_review_results",
    // PostgreSQL and the local memory adapter assign different legacy names.
    sql: `ALTER TABLE plan_ai_reviews DROP CONSTRAINT IF EXISTS plan_ai_reviews_snapshot_id_audience_key;
          ALTER TABLE plan_ai_reviews DROP CONSTRAINT IF EXISTS "plan_ai_reviews_audience|snapshot_id_idx";
          ALTER TABLE plan_ai_reviews ADD CONSTRAINT plan_ai_reviews_version_unique UNIQUE(snapshot_id, audience, prompt_version, schema_version);
          ALTER TABLE cycle_ai_analyses DROP CONSTRAINT IF EXISTS cycle_ai_analyses_snapshot_id_analysis_type_key;
          ALTER TABLE cycle_ai_analyses DROP CONSTRAINT IF EXISTS "cycle_ai_analyses_analysis_type|snapshot_id_idx";
          ALTER TABLE cycle_ai_analyses ADD CONSTRAINT cycle_ai_analyses_version_unique UNIQUE(snapshot_id, analysis_type, prompt_version, schema_version);`,
  },
  {
    version: "0008",
    name: "preserve_raw_cycle_discussion_evidence",
    sql: `ALTER TABLE cycle_evidence_snapshots ADD COLUMN discussion_entries JSONB;
          CREATE INDEX idx_discussion_entries_cycle ON discussion_entries(cycle_id, activity_date, created_at);`,
  },
  {
    version: "0009",
    name: "cycle_scoped_daily_discussion_summaries",
    // Preserve the old session/date tables as read-only legacy records.
    sql: `CREATE TABLE cycle_discussion_days (
            session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
            cycle_id TEXT NOT NULL REFERENCES inquiry_cycles(id),
            activity_date TEXT NOT NULL,
            requested_version INTEGER NOT NULL DEFAULT 1,
            generated_version INTEGER NOT NULL DEFAULT 0,
            lease_token TEXT, lease_until TIMESTAMPTZ, retry_after TIMESTAMPTZ,
            immediate_requested BOOLEAN NOT NULL DEFAULT FALSE,
            status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (session_id, cycle_id, activity_date)
          );
          CREATE TABLE cycle_discussion_backfills (
            cycle_id TEXT PRIMARY KEY REFERENCES inquiry_cycles(id),
            completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE cycle_discussion_summaries (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
            cycle_id TEXT NOT NULL REFERENCES inquiry_cycles(id),
            activity_date TEXT NOT NULL, version INTEGER NOT NULL,
            content JSONB NOT NULL, sources JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (session_id, cycle_id, activity_date, version)
          );`,
  },
  {
    version: "0010",
    name: "discussion_message_recipient_memberships",
    // No historical backfill: the membership at an old send time is unknown.
    sql: `CREATE TABLE discussion_message_recipients (
            entry_id TEXT NOT NULL REFERENCES discussion_entries(id),
            membership_id TEXT NOT NULL REFERENCES team_members(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            read_at TIMESTAMPTZ,
            PRIMARY KEY (entry_id, user_id)
          );
          CREATE INDEX idx_discussion_recipients_user ON discussion_message_recipients(user_id, entry_id);`,
  },
  {
    version: "0011",
    name: "discussion_push_outbox",
    sql: `CREATE TABLE discussion_push_outbox (
      entry_id TEXT NOT NULL, user_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL, subscription_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entry_id, subscription_id),
      FOREIGN KEY (entry_id, user_id) REFERENCES discussion_message_recipients(entry_id, user_id)
    );
    CREATE INDEX idx_discussion_push_pending ON discussion_push_outbox(status, next_attempt_at);`,
  },
  {
    version: "0012",
    name: "material_amount_without_budget_ceiling",
    sql: "ALTER TABLE material_requests ALTER COLUMN total_amount TYPE BIGINT;",
  },
];

function checksum(migration: DatabaseMigration) {
  return createHash("sha256").update(`${migration.version}\n${migration.name}\n${migration.sql}`).digest("hex");
}

function assertMigrationOrder(migrations: readonly DatabaseMigration[]) {
  const versions = migrations.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length || versions.some((version, index) => index > 0 && version <= versions[index - 1]!)) {
    throw new Error("DB 마이그레이션 번호는 중복 없이 오름차순이어야 합니다.");
  }
}

// Read-only: invoke before the baseline schema or seed can modify an existing DB.
// Reject unknown versions conservatively; migration numbering is not a promise
// that a newer schema remains compatible with an older app.
export async function assertDatabaseCompatibility(pool: Pick<Pool, "query">, migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS) {
  assertMigrationOrder(migrations);
  const tables = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'",
  );
  if (!tables.rows.length) return;
  const applied = await pool.query<{ version: string; name: string; checksum: string }>(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied.rows) {
    const migration = known.get(row.version);
    if (!migration) throw new Error("현재 앱이 지원하지 않는 DB 마이그레이션이 있습니다. 호환되는 앱 버전을 사용하세요.");
    if (row.name !== migration.name || row.checksum !== checksum(migration)) {
      throw new Error(`이미 적용된 DB 마이그레이션 ${migration.version}의 내용이 변경되었습니다.`);
    }
  }
}

export async function runDatabaseMigrations(pool: Pool, migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS) {
  assertMigrationOrder(migrations);
  await assertDatabaseCompatibility(pool, migrations);
  // PostgreSQL's CREATE TABLE IF NOT EXISTS can still race in pg_catalog when
  // separate first-start instances create the same relation simultaneously.
  // A session advisory lock protects the lock tables before their row lock can
  // exist. The in-memory development/test database runs sequentially and does
  // not implement PostgreSQL advisory locks.
  const usePostgresAdvisoryLock = Boolean(process.env.DATABASE_URL || process.env.INSTANCE_UNIX_SOCKET);
  const advisoryKey = "4934051600001";
  const migrationTableSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
  const lockTableSql = `CREATE TABLE IF NOT EXISTS schema_migration_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1)
  )`;
  if (usePostgresAdvisoryLock) {
    const bootstrap = await pool.connect();
    try {
      await bootstrap.query("SELECT pg_advisory_lock($1::bigint)", [advisoryKey]);
      await bootstrap.query(migrationTableSql);
      await bootstrap.query(lockTableSql);
      await bootstrap.query("INSERT INTO schema_migration_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    } finally {
      await bootstrap.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryKey]).catch(() => undefined);
      bootstrap.release();
    }
  } else {
    // pg-mem cannot execute CREATE TABLE IF NOT EXISTS through a connected
    // client when the planner sees unsupported constraint AST fields.
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('schema_migrations', 'schema_migration_lock')`,
    );
    const existingTables = new Set(tables.rows.map((row) => row.table_name));
    if (!existingTables.has("schema_migrations")) await pool.query(migrationTableSql);
    if (!existingTables.has("schema_migration_lock")) await pool.query(lockTableSql);
    await pool.query("INSERT INTO schema_migration_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  }

  for (const migration of migrations) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM schema_migration_lock WHERE id = 1 FOR UPDATE");
      await assertDatabaseCompatibility(client, migrations);
      const applied = await client.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      const expectedChecksum = checksum(migration);
      if (applied.rows[0]) {
        if (applied.rows[0].name !== migration.name || applied.rows[0].checksum !== expectedChecksum) {
          throw new Error(`이미 적용된 DB 마이그레이션 ${migration.version}의 내용이 변경되었습니다.`);
        }
        await client.query("COMMIT");
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, expectedChecksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
