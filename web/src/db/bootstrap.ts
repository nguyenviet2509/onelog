/**
 * One-shot DB bootstrap — idempotent CREATE TABLE IF NOT EXISTS + seed user.
 *
 * Runs lazily on first DB access via `ensureBootstrap()`. Cheaper than running
 * drizzle-kit migrations for a 3-table MVP schema; swap to migrations when the
 * schema grows or we need versioned rollbacks.
 */
import postgres from "postgres";

let _done = false;

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE,
  name        VARCHAR(128),
  role        VARCHAR(32)  NOT NULL DEFAULT 'admin',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       VARCHAR(200) NOT NULL DEFAULT 'New conversation',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             VARCHAR(16) NOT NULL,
  content          TEXT NOT NULL,
  parts            JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user
  ON conversations(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conv
  ON messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  source           VARCHAR(32) NOT NULL,
  conversation_id  UUID,
  prompt           TEXT NOT NULL,
  tool_calls       JSONB,
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  status           VARCHAR(16) NOT NULL DEFAULT 'ok',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_time
  ON audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_source_time
  ON audit_log(source, created_at DESC);

INSERT INTO users (id, email, name, role)
VALUES (1, 'sysadmin@local', 'sysadmin', 'admin')
ON CONFLICT (id) DO NOTHING;

-- KB Phase 1 tables -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb_taxonomy (
  kind        VARCHAR(16)  NOT NULL,
  value       VARCHAR(64)  NOT NULL,
  usage_count INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS kb_entries (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE SET NULL: conversation deletion must not cascade-delete KB knowledge.
  -- UNIQUE (nullable): backfill dedup logic assumes at most 1 entry per conversation.
  conversation_id UUID         REFERENCES conversations(id) ON DELETE SET NULL UNIQUE,
  title           VARCHAR(200) NOT NULL,
  department      VARCHAR(32),
  topic           VARCHAR(64),
  issue_type      VARCHAR(64),
  tags            TEXT[],
  symptom         TEXT         NOT NULL,
  root_cause      TEXT         NOT NULL,
  fix             TEXT         NOT NULL,
  embedding_id    VARCHAR(128),
  created_by      INTEGER      NOT NULL REFERENCES users(id),
  upvotes         INTEGER      NOT NULL DEFAULT 0,
  verified_by     INTEGER[],
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_entries_conv
  ON kb_entries(conversation_id);

CREATE INDEX IF NOT EXISTS idx_kb_entries_dept_topic
  ON kb_entries(department, topic, issue_type);

CREATE TABLE IF NOT EXISTS kb_edits (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    UUID        NOT NULL REFERENCES kb_entries(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id),
  diff_json   JSONB       NOT NULL,
  edited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_edits_entry
  ON kb_edits(entry_id, edited_at DESC);

-- Seed initial departments (taxonomy bootstrap)
INSERT INTO kb_taxonomy (kind, value, usage_count) VALUES
  ('department', 'SRE',      0),
  ('department', 'DBA',      0),
  ('department', 'NetOps',   0),
  ('department', 'AppDev',   0),
  ('department', 'Security', 0)
ON CONFLICT (kind, value) DO NOTHING;
`;

export async function ensureBootstrap(): Promise<void> {
  if (_done) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  // Use a one-shot postgres.js client — close immediately. Bootstrap runs
  // once per process, so the pool churn is negligible.
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(DDL);
    _done = true;
  } finally {
    await sql.end({ timeout: 1 });
  }
}
