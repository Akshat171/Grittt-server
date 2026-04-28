import { pool } from './pool';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Fix bad_day_logs: unique should be per user+date, not date alone
    await client.query(`ALTER TABLE bad_day_logs DROP CONSTRAINT IF EXISTS bad_day_logs_date_key`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bad_day_user_date_unique ON bad_day_logs(user_id, date)`);
    await client.query('COMMIT');
    console.log('✅ Fixed bad_day_logs unique constraint to (user_id, date)');
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
