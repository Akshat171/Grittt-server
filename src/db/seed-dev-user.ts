/**
 * Creates a dummy dev user for local development.
 * Run with: npx ts-node src/db/seed-dev-user.ts
 *
 * Credentials:  dev@grittt.com  /  Dev@12345
 */
import dotenv from 'dotenv';
dotenv.config();

import bcrypt from 'bcryptjs';
import { pool } from './pool';

async function seed() {
  const email = 'dev@grittt.com';
  const name  = 'Dev User';
  const password = 'Dev@12345';

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           name          = EXCLUDED.name`,
    [email, name, hash],
  );

  console.log('✅ Dev user ready:');
  console.log('   Email   :', email);
  console.log('   Password:', password);
  await pool.end();
}

seed().catch(err => { console.error(err); process.exit(1); });
