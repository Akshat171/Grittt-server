import { pool } from './pool';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add new columns to tasks table for habit v2 features
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tiny_version TEXT NULL`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS why_started TEXT NULL`);

    // Add completion_type to habit_completions (full or tiny)
    await client.query(`ALTER TABLE habit_completions ADD COLUMN IF NOT EXISTS completion_type TEXT NOT NULL DEFAULT 'full'`);

    // Streak shields table - users get 2 per month
    await client.query(`
      CREATE TABLE IF NOT EXISTS streak_shields (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        used_date DATE NOT NULL,
        month_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shields_user_month ON streak_shields(user_id, month_key)`);

    // Bad day log - track when user activates bad day mode
    await client.query(`
      CREATE TABLE IF NOT EXISTS bad_day_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bad_day_user ON bad_day_logs(user_id, date)`);

    await client.query('COMMIT');
    console.log('✅ Migration complete: habits v2 (tiny_version, why_started, completion_type, streak_shields, bad_day_logs)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
