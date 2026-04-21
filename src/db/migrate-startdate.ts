import { pool } from './pool';

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add start_date and category columns if they don't exist
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE NULL`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'build'`);

    // Set start_date = 2026-04-05 for all tasks belonging to adisoni1017@gmail.com
    const result = await client.query(`
      UPDATE tasks
      SET start_date = '2026-04-05'
      WHERE user_id = (
        SELECT id FROM users WHERE email = 'adisoni1017@gmail.com' LIMIT 1
      )
      RETURNING id, name, start_date
    `);

    console.log(`✅ Updated ${result.rowCount} tasks for adisoni1017@gmail.com`);
    result.rows.forEach(r => console.log(`  - ${r.name}: ${r.start_date}`));

    await client.query('COMMIT');
    console.log('✅ Migration complete: start_date column added');
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
