/**
 * Migration: Extend daily_scores with per-domain breakdown columns
 *
 * The daily_scores table already exists (created by migrate-strength.ts).
 * This migration adds discipline_score, strength_score, food_score, and
 * final_score columns so the full composite score can be stored per day.
 *
 * Run: npx ts-node src/db/migrate-daily-scores.ts
 */

import { pool } from './pool';

const SQL = `
-- Add breakdown columns to existing daily_scores table
ALTER TABLE daily_scores
  ADD COLUMN IF NOT EXISTS discipline_score   FLOAT,
  ADD COLUMN IF NOT EXISTS strength_score     FLOAT,
  ADD COLUMN IF NOT EXISTS food_score         FLOAT,
  ADD COLUMN IF NOT EXISTS final_score        FLOAT,
  ADD COLUMN IF NOT EXISTS composite_xp_earned FLOAT;

-- Ensure composite index exists (idempotent)
CREATE INDEX IF NOT EXISTS idx_daily_scores_user_date ON daily_scores(user_id, date);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SQL);
    await client.query('COMMIT');
    console.log('✅ daily_scores migration complete: discipline_score, strength_score, food_score, final_score columns added');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ daily_scores migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
