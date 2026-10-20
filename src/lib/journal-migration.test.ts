import { newDb } from "pg-mem";
import { expect, it } from "vitest";
import { SCHEMA_SQL } from "@/lib/db/schema";
import { DATABASE_MIGRATIONS, runDatabaseMigrations } from "@/lib/db/migrations";
import type { Pool } from "pg";

// This unit test owns the journal migrations. pg-mem cannot faithfully execute
// the record migration's duplicate `id` projection; the complete 0012→0015
// upgrade and both assignment tables are verified against PostgreSQL 16 in CI.
const journalMigrations = DATABASE_MIGRATIONS.filter(m => m.version <= "0014");

it("seeds class grants only for the documented login AND matching name in 2026", async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const db = new (memory.adapters.createPg().Pool)() as unknown as Pool;
  try {
    await db.query(SCHEMA_SQL); await runDatabaseMigrations(db, DATABASE_MIGRATIONS.filter(m => m.version < "0013"));
    for (let n = 1; n <= 9; n++) await db.query("INSERT INTO classes(id,academic_year,class_number,name) VALUES($1,2026,$2,$1)", [`class${n}`, n]);
    for (const [id, login, name, year] of [["one", "teacher1", "강석봉", 2026], ["two", "teacher2", "김보철", 2026], ["three", "teacher3", "김정원", 2026], ["four", "teacher4", "다른 사람", 2026], ["old", "teacher4", "원창연", 2025]]) {
      await db.query("INSERT INTO users(id,login_id,name,academic_year,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,'teacher','synthetic',FALSE)", [id, login, name, year]);
    }
    await runDatabaseMigrations(db, journalMigrations);
    expect((await db.query("SELECT teacher_id,class_id FROM class_journal_teacher_assignments ORDER BY teacher_id,class_id")).rows).toEqual([
      { teacher_id: "one", class_id: "class3" }, { teacher_id: "one", class_id: "class4" },
      { teacher_id: "three", class_id: "class5" }, { teacher_id: "three", class_id: "class6" }, { teacher_id: "three", class_id: "class7" },
      { teacher_id: "two", class_id: "class8" }, { teacher_id: "two", class_id: "class9" },
    ]);
    await runDatabaseMigrations(db, journalMigrations);
    expect((await db.query("SELECT COUNT(*)::int AS n FROM class_journal_teacher_assignments")).rows[0].n).toBe(7);
  } finally { await db.end(); }
});
