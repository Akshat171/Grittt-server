import { pool, queryOne } from './pool';
import { UserIdentity, DailyScore, FullDailyScore } from '../types';

// ── user_identity ──────────────────────────────────────────────────────────────

export async function getIdentity(
  userId: string,
  domain: string
): Promise<UserIdentity | null> {
  return queryOne<UserIdentity>(
    `SELECT * FROM user_identity WHERE user_id = $1 AND domain = $2`,
    [userId, domain]
  );
}

export async function upsertIdentity(
  client: import('pg').PoolClient,
  userId: string,
  domain: string,
  totalXP: number,
  levelIndex: number,
  levelName: string
): Promise<UserIdentity> {
  const row = await client.query<UserIdentity>(
    `INSERT INTO user_identity (user_id, domain, total_xp, level_index, level_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, domain) DO UPDATE
       SET total_xp   = EXCLUDED.total_xp,
           level_index = EXCLUDED.level_index,
           level_name  = EXCLUDED.level_name,
           updated_at  = NOW()
     RETURNING *`,
    [userId, domain, totalXP, levelIndex, levelName]
  );
  return row.rows[0];
}

// ── daily_scores ───────────────────────────────────────────────────────────────

/**
 * Returns the previous xp_earned for (user, date) if it exists, so we can
 * compute the correct XP delta on re-submission.
 */
export async function getPreviousDailyScore(
  client: import('pg').PoolClient,
  userId: string,
  date: string
): Promise<Pick<DailyScore, 'score' | 'xp_earned'> | null> {
  const result = await client.query<Pick<DailyScore, 'score' | 'xp_earned'>>(
    `SELECT score, xp_earned FROM daily_scores WHERE user_id = $1 AND date = $2`,
    [userId, date]
  );
  return result.rows[0] ?? null;
}

export async function upsertDailyScore(
  client: import('pg').PoolClient,
  userId: string,
  date: string,
  score: number,
  xpEarned: number
): Promise<DailyScore> {
  const result = await client.query<DailyScore>(
    `INSERT INTO daily_scores (user_id, date, score, xp_earned)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, date) DO UPDATE
       SET score      = EXCLUDED.score,
           xp_earned  = EXCLUDED.xp_earned
     RETURNING *`,
    [userId, date, score, xpEarned]
  );
  return result.rows[0];
}

export async function upsertFullDailyScore(
  client: import('pg').PoolClient,
  userId: string,
  date: string,
  disciplineScore: number,
  strengthScore: number,
  foodScore: number,
  finalScore: number,
  xpEarned: number
): Promise<FullDailyScore> {
  const result = await client.query<FullDailyScore>(
    `INSERT INTO daily_scores
       (user_id, date, score, discipline_score, strength_score, food_score, final_score, composite_xp_earned)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, date) DO UPDATE
       SET score                = EXCLUDED.score,
           discipline_score     = EXCLUDED.discipline_score,
           strength_score       = EXCLUDED.strength_score,
           food_score           = EXCLUDED.food_score,
           final_score          = EXCLUDED.final_score,
           composite_xp_earned  = EXCLUDED.composite_xp_earned
     RETURNING *`,
    [userId, date, finalScore, disciplineScore, strengthScore, foodScore, finalScore, xpEarned]
  );
  return result.rows[0];
}

export async function getPreviousFullDailyScore(
  client: import('pg').PoolClient,
  userId: string,
  date: string
): Promise<Pick<FullDailyScore, 'final_score' | 'composite_xp_earned'> | null> {
  const result = await client.query<Pick<FullDailyScore, 'final_score' | 'composite_xp_earned'>>(
    `SELECT final_score, composite_xp_earned FROM daily_scores WHERE user_id = $1 AND date = $2`,
    [userId, date]
  );
  return result.rows[0] ?? null;
}

// ── leaderboard ────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  user_id: string;
  name: string;
  avatar_url: string | null;
  score: number;
  rank: number;
}

export async function getLeaderboard(date: string): Promise<LeaderboardEntry[]> {
  const result = await pool.query<LeaderboardEntry>(
    `SELECT
       ds.user_id,
       u.name,
       u.avatar_url,
       ds.score,
       RANK() OVER (ORDER BY ds.score DESC) AS rank
     FROM daily_scores ds
     JOIN users u ON u.id = ds.user_id
     WHERE ds.date = $1
     ORDER BY rank`,
    [date]
  );
  return result.rows;
}
