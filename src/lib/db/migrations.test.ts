import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SCHEMA_SQL } from "@/lib/db/schema";
import { assertDatabaseCompatibility, DATABASE_MIGRATIONS, runDatabaseMigrations, type DatabaseMigration } from "@/lib/db/migrations";

function memoryPool() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as unknown as Pool;
}

describe("numbered database migrations", () => {
  it("leaves a fresh database untouched during compatibility inspection", async () => {
    const pool = memoryPool();
    try {
      await assertDatabaseCompatibility(pool);
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows).toEqual([]);
    } finally { await pool.end(); }
  });

  it("rejects an incompatible history before creating a missing lock table", async () => {
    const pool = memoryPool();
    try {
      await pool.query("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)");
      await pool.query("INSERT INTO schema_migrations VALUES ('9999', 'synthetic_future', 'synthetic')");
      await expect(runDatabaseMigrations(pool)).rejects.toThrow("지원하지 않는");
      expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows).toEqual([{ table_name: "schema_migrations" }]);
      await expect(runDatabaseMigrations(pool, [])).rejects.toThrow("지원하지 않는");
    } finally { await pool.end(); }
  });

  it("rejects a database with an unknown future migration without changing its records", async () => {
    const pool = memoryPool();
    try {
      await pool.query(SCHEMA_SQL);
      await runDatabaseMigrations(pool);
      await pool.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ('9999', 'synthetic_future_schema', 'synthetic-checksum')",
      );
      const before = (await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
      await expect(runDatabaseMigrations(pool)).rejects.toThrow("지원하지 않는");
      expect((await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(before);
    } finally {
      await pool.end();
    }
  });

  it("records the immutable migration once on a fresh bootstrap", async () => {
    const pool = memoryPool();
    await pool.query(SCHEMA_SQL);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'session_version'")).rows).toHaveLength(0);
    expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'ai_generation_jobs'")).rows).toHaveLength(0);
    await runDatabaseMigrations(pool);
    await runDatabaseMigrations(pool);
    const applied = await pool.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    expect(applied.rows).toHaveLength(DATABASE_MIGRATIONS.length);
    expect(applied.rows[0]).toMatchObject({ version: "0001", name: "current_schema_baseline" });
    expect(applied.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'session_version'")).rows).toHaveLength(1);
    await expect(pool.query("SELECT id FROM ai_generation_jobs")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM inquiry_cycles")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM plan_document_snapshots")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM plan_submissions")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM plan_ai_reviews")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM cycle_evidence_snapshots")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM cycle_ai_analyses")).resolves.toMatchObject({ rows: [] });
    await expect(pool.query("SELECT id FROM cycle_ai_decisions")).resolves.toMatchObject({ rows: [] });
    await pool.end();
  });

  it("rejects an edited migration after its version was applied", async () => {
    const pool = memoryPool();
    await pool.query(SCHEMA_SQL);
    await runDatabaseMigrations(pool);
    const edited: DatabaseMigration[] = [{ ...DATABASE_MIGRATIONS[0]!, sql: `${DATABASE_MIGRATIONS[0]!.sql}\nSELECT 1;` }];
    await expect(runDatabaseMigrations(pool, edited)).rejects.toThrow("내용이 변경");
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(DATABASE_MIGRATIONS.length);
    await pool.end();
  });

  it("links existing documents to an unclassified cycle without changing their content or approval", async () => {
    const pool = memoryPool();
    await pool.query(SCHEMA_SQL);
    await pool.query("INSERT INTO classes (id, academic_year, class_number, name) VALUES ('legacy_class', 2026, 1, '기존 학급')");
    await pool.query("INSERT INTO users (id, name, login_id, academic_year, role, password_hash, must_change_password) VALUES ('legacy_teacher', '기존 교사', 'legacy-teacher', 2026, 'teacher', 'unused', FALSE)");
    await pool.query("INSERT INTO teams (id, class_id, team_number, name) VALUES ('legacy_team', 'legacy_class', 1, '기존 팀')");
    await pool.query("INSERT INTO inquiry_sessions (id, team_id) VALUES ('legacy_session', 'legacy_team')");
    await pool.query(
      "INSERT INTO investigation_plans (id, session_id, form_data, review_status) VALUES ('legacy_plan', 'legacy_session', $1, 'approved')",
      [JSON.stringify({ topic: "기존 내용", method: "원래 방법" })],
    );
    await pool.query("INSERT INTO reports (id, session_id, form_data, status) VALUES ('legacy_report', 'legacy_session', $1, 'reviewed')", [JSON.stringify({ result: "원래 결과" })]);
    await pool.query("INSERT INTO messages (id, session_id, role, content, sequence) VALUES ('legacy_message', 'legacy_session', 'assistant', '기존 대화', 1)");
    await pool.query("INSERT INTO document_revisions (id, document_type, document_id, action, snapshot, changed_by) VALUES ('legacy_revision', 'plan', 'legacy_plan', 'legacy', '{}', 'legacy_teacher')");
    const before = (await pool.query("SELECT form_data, review_status FROM investigation_plans WHERE id = 'legacy_plan'")).rows[0];

    await runDatabaseMigrations(pool);

    const cycle = (await pool.query("SELECT id, title, origin, status FROM inquiry_cycles WHERE session_id = 'legacy_session'")).rows[0];
    expect(cycle).toMatchObject({ id: "cycle_legacy_session_1", title: "기존 탐구 자료", origin: "legacy_unclassified", status: "active" });
    expect((await pool.query("SELECT form_data, review_status FROM investigation_plans WHERE id = 'legacy_plan'")).rows[0]).toEqual(before);
    expect((await pool.query("SELECT cycle_id FROM investigation_plans WHERE id = 'legacy_plan'")).rows[0].cycle_id).toBe(cycle.id);
    expect((await pool.query("SELECT cycle_id, status FROM reports WHERE id = 'legacy_report'")).rows[0]).toMatchObject({ cycle_id: cycle.id, status: "reviewed" });
    expect((await pool.query("SELECT write_version, form_data FROM reports WHERE id = 'legacy_report'")).rows[0]).toMatchObject({ write_version: 0, form_data: {result: "원래 결과"} });
    expect((await pool.query("SELECT cycle_id FROM messages WHERE id = 'legacy_message'")).rows[0].cycle_id).toBe(cycle.id);
    expect((await pool.query("SELECT cycle_id FROM document_revisions WHERE id = 'legacy_revision'")).rows[0].cycle_id).toBe(cycle.id);
    await pool.end();
  });

  it("rolls back a failed new migration and permits a corrected retry", async () => {
    const pool = memoryPool();
    await pool.query(SCHEMA_SQL);
    await runDatabaseMigrations(pool);
    const broken: DatabaseMigration = { version: "9998", name: "retry_probe", sql: "INSERT INTO table_that_does_not_exist VALUES (1)" };
    await expect(runDatabaseMigrations(pool, [...DATABASE_MIGRATIONS, broken])).rejects.toThrow();
    expect((await pool.query("SELECT version FROM schema_migrations WHERE version = '9998'")).rows).toHaveLength(0);
    const corrected: DatabaseMigration = { ...broken, sql: "CREATE TABLE migration_retry_probe (id INTEGER PRIMARY KEY)" };
    await runDatabaseMigrations(pool, [...DATABASE_MIGRATIONS, corrected]);
    expect((await pool.query("SELECT name FROM schema_migrations WHERE version = '9998'")).rows[0].name).toBe("retry_probe");
    await pool.end();
  });

  it("rejects duplicate or descending migration numbers before writing", async () => {
    const pool = memoryPool();
    const duplicate = [
      { version: "0002", name: "a", sql: "SELECT 1" },
      { version: "0002", name: "b", sql: "SELECT 1" },
    ];
    await expect(runDatabaseMigrations(pool, duplicate)).rejects.toThrow("오름차순");
    await expect(pool.query("SELECT * FROM schema_migrations")).rejects.toThrow();
    await pool.end();
  });
});
