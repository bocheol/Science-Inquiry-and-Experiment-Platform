export const DISCUSSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS discussion_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('peer', 'meeting', 'supplement')),
  activity_date TEXT NOT NULL,
  content TEXT NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]',
  parent_id TEXT REFERENCES discussion_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS discussion_confirmations (
  entry_id TEXT NOT NULL REFERENCES discussion_entries(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entry_id, user_id)
);
CREATE TABLE IF NOT EXISTS discussion_days (
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  activity_date TEXT NOT NULL,
  requested_version INTEGER NOT NULL DEFAULT 1,
  generated_version INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  retry_after TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (session_id, activity_date)
);
CREATE TABLE IF NOT EXISTS discussion_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inquiry_sessions(id),
  activity_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  content JSONB NOT NULL,
  sources JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, activity_date, version)
);
ALTER TABLE discussion_days ADD COLUMN IF NOT EXISTS immediate_requested BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_discussion_session_date ON discussion_entries(session_id, activity_date, created_at);
CREATE INDEX IF NOT EXISTS idx_discussion_summaries_day ON discussion_summaries(session_id, activity_date, version);
CREATE INDEX IF NOT EXISTS idx_messages_created_session ON messages(session_id, created_at);
`;
