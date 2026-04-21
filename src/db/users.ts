import { query, queryOne } from './pool';
import { User } from '../types';

export async function findUserById(id: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function findUserByEmail(email: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE email = $1', [email]);
}

export async function findUserByGoogleId(googleId: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE google_id = $1', [googleId]);
}

export async function createUser(data: {
  email: string;
  name: string;
  avatar_url?: string | null;
  google_id?: string | null;
  password_hash?: string | null;
}): Promise<User> {
  const user = await queryOne<User>(
    `INSERT INTO users (email, name, avatar_url, google_id, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.email, data.name, data.avatar_url ?? null, data.google_id ?? null, data.password_hash ?? null]
  );
  if (!user) throw new Error('Failed to create user');
  return user;
}

export async function upsertGoogleUser(data: {
  google_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}): Promise<User> {
  const user = await queryOne<User>(
    `INSERT INTO users (google_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_id) DO UPDATE
       SET name = EXCLUDED.name,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = NOW()
     RETURNING *`,
    [data.google_id, data.email, data.name, data.avatar_url]
  );
  if (!user) throw new Error('Failed to upsert Google user');
  return user;
}

export async function updateUserPassword(id: string, password_hash: string): Promise<void> {
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, id]);
}
