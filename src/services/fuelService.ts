import { pool } from '../db/pool';
import { upsertIdentity, getIdentity } from '../db/identity';

const LEVELS = [
  'Unaware','Tracking','Conscious','Intentional','Balanced','Clean','Structured','Optimized','Precise','Dialed','Peak','Surgical'
];

export interface FuelDayInput {
  date: string; // YYYY-MM-DD
  caloriesConsumed: number;
  calorieTarget: number;
  protein: number;
  proteinTarget: number;
  mealsLogged: number;
  expectedMeals: number;
  junkMeals: number;
}

export function clamp01(v: number) {
  if (!isFinite(v) || isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function calculateFuelScore(input: FuelDayInput): number {
  // Defensive: coerce numbers
  const cConsumed = Number(input.caloriesConsumed || 0);
  const cTarget = Number(input.calorieTarget || 0);
  const protein = Number(input.protein || 0);
  const pTarget = Number(input.proteinTarget || 0);
  const mealsLogged = Number(input.mealsLogged || 0);
  const expectedMeals = Number(input.expectedMeals || 0);
  const junkMeals = Math.max(0, Number(input.junkMeals || 0));

  // 1. Calorie Accuracy
  let calorieAccuracy = 0;
  if (cTarget > 0) {
    calorieAccuracy = 1 - Math.abs(cConsumed - cTarget) / cTarget;
    calorieAccuracy = clamp01(calorieAccuracy);
  }

  // 2. Protein Score
  let proteinScore = 0;
  if (pTarget > 0) {
    proteinScore = protein / pTarget;
    proteinScore = clamp01(proteinScore);
  }

  // 3. Meal Consistency
  let consistencyScore = 0;
  if (expectedMeals > 0) {
    consistencyScore = mealsLogged / expectedMeals;
    consistencyScore = clamp01(consistencyScore);
  }

  // 4. Junk Penalty
  const junkPenalty = junkMeals * 5;

  // 5. Final Fuel Score
  let fuelScore = (calorieAccuracy * 40) + (proteinScore * 30) + (consistencyScore * 30) - junkPenalty;
  if (!isFinite(fuelScore) || isNaN(fuelScore)) fuelScore = 0;
  fuelScore = Math.max(0, fuelScore);
  // round to 2 decimals
  return Math.round(fuelScore * 100) / 100;
}

export function calculateFuelXP(fuelScore: number): number {
  const xp = Number(fuelScore) * 2;
  return Math.round(xp * 100) / 100;
}

export function getLevelFromXP(totalXP: number) {
  const idx = Math.floor(Math.sqrt(totalXP / 100));
  const capped = Math.min(idx, LEVELS.length - 1);
  return { levelIndex: capped, levelName: LEVELS[capped] };
}

// DB helpers for fuel_daily_scores
export async function getPreviousFuelDaily(client: import('pg').PoolClient, userId: string, date: string) {
  const r = await client.query(`SELECT fuel_score, xp_earned FROM fuel_daily_scores WHERE user_id = $1 AND date = $2`, [userId, date]);
  return r.rows[0] ?? null;
}

export async function upsertFuelDaily(client: import('pg').PoolClient, userId: string, date: string, fuelScore: number, xpEarned: number) {
  const r = await client.query(
    `INSERT INTO fuel_daily_scores (user_id, date, fuel_score, xp_earned) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, date) DO UPDATE SET fuel_score = EXCLUDED.fuel_score, xp_earned = EXCLUDED.xp_earned RETURNING *`,
    [userId, date, fuelScore, xpEarned]
  );
  return r.rows[0];
}

/**
 * Submit a day's fuel data: compute score/xp, upsert daily, and update user_identity atomically.
 * Returns { fuelScore, xpEarned, levelName, levelChanged }
 */
export async function submitFuelDay(userId: string, input: FuelDayInput) {
  // validate date
  if (!input || !input.date) throw new Error('Missing date');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fuelScore = calculateFuelScore(input);
    const xpEarned = calculateFuelXP(fuelScore);

    // previous XP for date (if any)
    const prev = await getPreviousFuelDaily(client, userId, input.date);
    const prevXP = prev?.xp_earned ? Number(prev.xp_earned) : 0;

    // upsert daily
    await upsertFuelDaily(client, userId, input.date, fuelScore, xpEarned);

    // identity: compute new totalXP
    const existing = await getIdentity(userId, 'Fuel');
    const prevTotal = existing?.total_xp ?? 0;
    const newTotal = Math.max(0, prevTotal - prevXP + xpEarned);

    const { levelIndex, levelName } = getLevelFromXP(newTotal);

    const identity = await upsertIdentity(client, userId, 'Fuel', newTotal, levelIndex, levelName);

    await client.query('COMMIT');

    return {
      fuelScore,
      xpEarned,
      levelName: identity.level_name,
      levelChanged: identity.level_index !== (existing?.level_index ?? -1),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getFuelIdentity(userId: string) {
  const identity = await getIdentity(userId, 'Fuel');
  if (!identity) return { totalXP: 0, levelIndex: 0, levelName: LEVELS[0] };
  return { totalXP: identity.total_xp, levelIndex: identity.level_index, levelName: identity.level_name };
}
