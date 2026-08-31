export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  academic_year INTEGER NOT NULL,
  class_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (academic_year, class_number)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  login_id TEXT NOT NULL,
  academic_year INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
  class_id TEXT REFERENCES classes(id),
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (academic_year, login_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  team_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  leader_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at TIMESTAMPTZ,
  archived_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (class_id, team_number)
);

ALTER TABLE teams ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS archived_by TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE IF NOT EXISTS inquiry_sessions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL UNIQUE REFERENCES teams(id),
  interest_input TEXT,
  selected_topic TEXT,
  stage TEXT NOT NULL DEFAULT 'STARTING',
  conversation_summary TEXT NOT NULL DEFAULT '',
  ai_topic_suggestions JSONB NOT NULL DEFAULT '{}',
  ai_busy BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  sender_id TEXT REFERENCES users(id),
  sender_alias TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS investigation_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES inquiry_sessions(id),
  form_data JSONB NOT NULL DEFAULT '{}',
  review_status TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'pending', 'feedback', 'approved', 'reapproval_required')),
  teacher_feedback TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS field_locks (
  plan_id TEXT NOT NULL REFERENCES investigation_plans(id),
  field_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  user_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (plan_id, field_key)
);

CREATE TABLE IF NOT EXISTS material_requests (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  form_data JSONB NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  budget_status TEXT NOT NULL DEFAULT 'within_budget' CHECK (budget_status IN ('within_budget', 'over_budget', 'approved')),
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  sync_error TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS experiment_journals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  student_id TEXT NOT NULL REFERENCES users(id),
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 100),
  journal_date DATE NOT NULL,
  activities TEXT NOT NULL DEFAULT '',
  observations TEXT NOT NULL DEFAULT '',
  reflections TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, student_id, session_number)
);

CREATE TABLE IF NOT EXISTS experiment_journal_images (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES experiment_journals(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_name TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  image_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (journal_id, client_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES inquiry_sessions(id),
  form_data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'feedback', 'reviewed')),
  teacher_feedback TEXT,
  reviewed_by TEXT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS report_member_roles (
  report_id TEXT NOT NULL REFERENCES reports(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role_description TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE IF NOT EXISTS report_fields (
  report_id TEXT NOT NULL REFERENCES reports(id),
  field_key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id, field_key)
);

CREATE TABLE IF NOT EXISTS report_field_locks (
  report_id TEXT NOT NULL REFERENCES reports(id),
  field_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  user_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (report_id, field_key)
);

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('plan', 'report')),
  document_id TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  action TEXT NOT NULL,
  changed_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exam_sets (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  common_count INTEGER NOT NULL CHECK (common_count BETWEEN 0 AND 5),
  team_count INTEGER NOT NULL CHECK (team_count BETWEEN 0 AND 5),
  individual_count INTEGER NOT NULL CHECK (individual_count BETWEEN 0 AND 3),
  total_score INTEGER NOT NULL DEFAULT 100 CHECK (total_score BETWEEN 1 AND 200),
  common_scope TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exam_questions (
  id TEXT PRIMARY KEY,
  exam_set_id TEXT NOT NULL REFERENCES exam_sets(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('common', 'team', 'individual')),
  team_id TEXT REFERENCES teams(id),
  student_id TEXT REFERENCES users(id),
  sequence INTEGER NOT NULL,
  stimulus TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'constructed' CHECK (question_type IN ('multiple_choice', 'short_answer', 'constructed')),
  competency TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'standard' CHECK (difficulty IN ('basic', 'standard', 'advanced')),
  max_score INTEGER NOT NULL CHECK (max_score BETWEEN 1 AND 100),
  model_answer TEXT NOT NULL,
  scoring_rubric JSONB NOT NULL DEFAULT '[]',
  source_evidence JSONB NOT NULL DEFAULT '[]',
  is_ai_generated BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  exam_set_id TEXT NOT NULL REFERENCES exam_sets(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  student_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'reviewed', 'graded', 'published')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by TEXT REFERENCES users(id),
  UNIQUE (exam_set_id, student_id)
);

CREATE TABLE IF NOT EXISTS exam_results (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL UNIQUE REFERENCES exams(id) ON DELETE CASCADE,
  question_scores JSONB NOT NULL DEFAULT '{}',
  total_score INTEGER NOT NULL DEFAULT 0,
  teacher_feedback TEXT NOT NULL DEFAULT '',
  graded_by TEXT REFERENCES users(id),
  graded_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS evaluation_templates (
  id TEXT PRIMARY KEY,
  academic_year INTEGER NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  self_reflection_questions JSONB NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS evaluation_rounds (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id),
  template_id TEXT NOT NULL REFERENCES evaluation_templates(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'reviewing', 'published')),
  template_snapshot JSONB NOT NULL,
  opened_by TEXT REFERENCES users(id),
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS self_evaluations (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  student_id TEXT NOT NULL REFERENCES users(id),
  responses JSONB NOT NULL,
  reflections JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (round_id, student_id)
);

CREATE TABLE IF NOT EXISTS peer_evaluations (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  evaluator_id TEXT NOT NULL REFERENCES users(id),
  evaluatee_id TEXT NOT NULL REFERENCES users(id),
  responses JSONB NOT NULL,
  private_evidence TEXT NOT NULL DEFAULT '',
  public_comment TEXT NOT NULL DEFAULT '',
  comment_review_status TEXT NOT NULL DEFAULT 'pending' CHECK (comment_review_status IN ('pending', 'approved', 'hidden')),
  redacted_public_comment TEXT NOT NULL DEFAULT '',
  flags JSONB NOT NULL DEFAULT '[]',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (evaluator_id <> evaluatee_id),
  UNIQUE (round_id, evaluator_id, evaluatee_id)
);

CREATE TABLE IF NOT EXISTS evaluation_publications (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  student_id TEXT NOT NULL REFERENCES users(id),
  peer_averages JSONB NOT NULL DEFAULT '{}',
  approved_comments JSONB NOT NULL DEFAULT '[]',
  teacher_summary TEXT NOT NULL DEFAULT '',
  published_by TEXT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (round_id, student_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teacher_requests (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL CHECK (category IN ('feature', 'bug', 'question', 'other')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'reviewing', 'planned', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'announcement' CHECK (kind IN ('announcement', 'action_request')),
  author_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type IN ('all', 'class', 'team')),
  class_id TEXT REFERENCES classes(id),
  team_id TEXT REFERENCES teams(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important')),
  calendar_start DATE,
  calendar_end DATE,
  source_type TEXT CHECK (source_type IS NULL OR source_type IN ('plan', 'report')),
  source_id TEXT,
  action_path TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_users_class ON users(class_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_material_team ON material_requests(team_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_journals_session_student ON experiment_journals(session_id, student_id, session_number);
CREATE INDEX IF NOT EXISTS idx_journal_images_journal ON experiment_journal_images(journal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_roles_report ON report_member_roles(report_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_report_fields_report ON report_fields(report_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_document_revisions_document ON document_revisions(document_type, document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exam_sets_class ON exam_sets(class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exam_questions_set_scope ON exam_questions(exam_set_id, scope, team_id, student_id, sequence);
CREATE INDEX IF NOT EXISTS idx_exams_student ON exams(student_id, status);
CREATE INDEX IF NOT EXISTS idx_evaluation_rounds_class ON evaluation_rounds(class_id, created_at);
CREATE INDEX IF NOT EXISTS idx_self_evaluations_student ON self_evaluations(student_id, round_id);
CREATE INDEX IF NOT EXISTS idx_peer_evaluations_target ON peer_evaluations(evaluatee_id, round_id);
CREATE INDEX IF NOT EXISTS idx_peer_evaluations_evaluator ON peer_evaluations(evaluator_id, round_id);
CREATE INDEX IF NOT EXISTS idx_evaluation_publications_student ON evaluation_publications(student_id, round_id);
CREATE INDEX IF NOT EXISTS idx_teams_status ON teams(status, class_id, team_number);
CREATE INDEX IF NOT EXISTS idx_teacher_requests_created ON teacher_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notices_status_created ON notices(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notices_audience ON notices(audience_type, class_id, team_id);
CREATE INDEX IF NOT EXISTS idx_notices_source ON notices(source_type, source_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_notice_reads_user ON notice_reads(user_id, read_at);

INSERT INTO reports (id, session_id)
SELECT 'report_' || id, id FROM inquiry_sessions
ON CONFLICT (session_id) DO NOTHING;

UPDATE inquiry_sessions
   SET stage = 'EXPERIMENTING'
 WHERE id IN (SELECT session_id FROM investigation_plans WHERE review_status = 'approved')
   AND stage IN ('STARTING', 'EXPLORING', 'PLANNING');
`;
