/**
 * Migration: Fuel Identity System
 *
 * Adds:
 *   - fuel_daily_scores (unique per user per date)
 * Run: node or via ts-node
 */

import { pool } from './pool';

const SQL = `
-- Fuel daily scores
CREATE TABLE IF NOT EXISTS fuel_daily_scores (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  fuel_score FLOAT NOT NULL DEFAULT 0,
  xp_earned FLOAT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_fuel_daily_user ON fuel_daily_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_fuel_daily_date ON fuel_daily_scores(date);
CREATE INDEX IF NOT EXISTS idx_fuel_daily_user_date ON fuel_daily_scores(user_id, date);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
    console.log('✅ Fuel migration complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Fuel migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
