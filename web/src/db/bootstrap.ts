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

INSERT INTO users (id, email, name, role)
VALUES (1, 'sysadmin@local', 'sysadmin', 'admin')
ON CONFLICT (id) DO NOTHING;
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
