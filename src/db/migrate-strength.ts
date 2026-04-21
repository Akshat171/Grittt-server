/**
 * Migration: Strength Identity System
 *
 * Adds:
 *   - user_identity  (composite PK: user_id + domain)
 *   - daily_scores   (unique per user per date)
 *
 * Run: npm run db:migrate-strength
 */

import { pool } from './pool';

const SQL = `
-- ── user_identity ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_identity (
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain      TEXT    NOT NULL,
  total_xp    FLOAT   NOT NULL DEFAULT 0,
  level_index INT     NOT NULL DEFAULT 0,
  level_name  TEXT    NOT NULL DEFAULT 'Starter',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_user_identity_user ON user_identity(user_id);

-- ── daily_scores ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_scores (
  id          SERIAL      PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,
  score       FLOAT       NOT NULL DEFAULT 0,
  xp_earned   FLOAT       NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_scores_user     ON daily_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_scores_date     ON daily_scores(date);
CREATE INDEX IF NOT EXISTS idx_daily_scores_user_date ON daily_scores(user_id, date);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
    console.log('✅ Strength migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Strength migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
