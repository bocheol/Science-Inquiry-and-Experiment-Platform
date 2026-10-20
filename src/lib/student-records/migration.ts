import type { DatabaseMigration } from "@/lib/db/migrations";

// 0013/0014 belong to the independent private-journal branch. Keep this ID stable.
export const STUDENT_RECORDS_MIGRATION: DatabaseMigration = {
  version: "0015",
  name: "course_separated_student_records",
  sql: `
    CREATE TABLE record_teacher_classes (
      class_id TEXT PRIMARY KEY REFERENCES classes(id),
      teacher_id TEXT NOT NULL REFERENCES users(id)
    );
    INSERT INTO record_teacher_classes (class_id, teacher_id)
      SELECT c.id, u.id FROM classes c JOIN users u ON u.academic_year = c.academic_year
      WHERE c.academic_year = 2026 AND u.role = 'teacher' AND u.status = 'active' AND (
        (u.login_id = 'teacher1' AND u.name = '강석봉' AND c.class_number IN (3,4)) OR
        (u.login_id = 'teacher2' AND u.name = '김보철' AND c.class_number IN (8,9)) OR
        (u.login_id = 'teacher3' AND u.name = '김정원' AND c.class_number IN (5,6,7)) OR
        (u.login_id = 'teacher4' AND u.name = '원창연' AND c.class_number IN (1,2))
      );
    CREATE TABLE record_teacher_settings (
      teacher_id TEXT PRIMARY KEY REFERENCES users(id),
      revision INTEGER NOT NULL DEFAULT 0,
      style TEXT NOT NULL DEFAULT '', opens_at TIMESTAMPTZ, deadline_at TIMESTAMPTZ,
      spreadsheet_id TEXT NOT NULL DEFAULT '', folder_id TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE record_submissions (
      student_id TEXT PRIMARY KEY REFERENCES users(id),
      revision INTEGER NOT NULL DEFAULT 0,
      selected JSONB NOT NULL DEFAULT '[]', comments JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','returned')),
      returned_note TEXT NOT NULL DEFAULT '', reopened_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE record_files (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id),
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      activity TEXT NOT NULL, course INTEGER NOT NULL CHECK (course IN (1,2)),
      file_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
      content_hash TEXT NOT NULL, file_data BYTEA NOT NULL,
      included BOOLEAN NOT NULL DEFAULT TRUE,
      revision INTEGER NOT NULL DEFAULT 1,
      extraction_status TEXT NOT NULL DEFAULT 'pending', extracted_text TEXT NOT NULL DEFAULT '',
      extraction_note TEXT NOT NULL DEFAULT '', reviewed_by TEXT REFERENCES users(id),
      drive_status TEXT NOT NULL DEFAULT 'pending', drive_file_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (student_id, activity, content_hash)
    );
    CREATE TABLE record_submission_versions (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL, snapshot JSONB NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (student_id, revision)
    );
    CREATE TABLE record_drafts (
      student_id TEXT PRIMARY KEY REFERENCES users(id), teacher_id TEXT NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL DEFAULT 0, source_revision INTEGER NOT NULL DEFAULT 0,
      course1 TEXT NOT NULL DEFAULT '', course2 TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', checked_groups JSONB NOT NULL DEFAULT '[]',
      evidence JSONB, ai_result JSONB,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE record_draft_versions (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL, snapshot JSONB NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (student_id, revision)
    );
    CREATE INDEX record_files_student ON record_files(student_id, activity);
  `,
};
