import { pool } from '../db/pool';
import {
  getIdentity,
  upsertIdentity,
  upsertDailyScore,
  getPreviousDailyScore,
  getLeaderboard,
  LeaderboardEntry,
} from '../db/identity';
import { SubmitDayInput, SubmitDayResult, UserIdentity } from '../types';

// ── Constants ──────────────────────────────────────────────────────────────────

export const DOMAIN = 'Strength' as const;

export const LEVEL_NAMES = [
  'Starter',
  'Initiate',
  'Committed',
  'Consistent',
  'Disciplined',
  'Relentless',
  'Forged',
  'Hardened',
  'Elite',
  'Unbreakable',
  'Titan',
  'Mythic',
] as const;

// ── Pure calculation functions ─────────────────────────────────────────────────

/**
 * Daily score formula:
 *   baseScore = (completedWeight / totalWeight) * 100
 *   penalty   = missedWeight * 0.3
 *   streakMul = 1 + streak * 0.02
 *   final     = (baseScore - penalty) * streakMul   (clamped >= 0)
 */
export function calculateScore(
  completedWeight: number,
  totalWeight: number,
  streak: number
): number {
  if (totalWeight <= 0) return 0;

  const clampedCompleted = Math.min(completedWeight, totalWeight);
  const missedWeight     = totalWeight - clampedCompleted;
  const baseScore        = (clampedCompleted / totalWeight) * 100;
  const penalty          = missedWeight * 0.3;
  const streakMultiplier = 1 + streak * 0.02;
  const raw              = (baseScore - penalty) * streakMultiplier;

  return Math.max(0, Math.round(raw * 100) / 100);
}

/**
 * XP formula:
 *   xp = completedWeight * 10 + streak * 5 - missedWeight * 2
 *   Clamped >= 0
 */
export function calculateXP(
  completedWeight: number,
  totalWeight: number,
  streak: number
): number {
  const missedWeight = Math.max(0, totalWeight - completedWeight);
  const xp = completedWeight * 10 + streak * 5 - missedWeight * 2;
  return Math.max(0, Math.round(xp * 100) / 100);
}

/**
 * Level formula:
 *   levelIndex = floor(sqrt(totalXP / 100))
 *   Capped at LEVEL_NAMES.length - 1
 */
export function getLevelFromXP(totalXP: number): {
  levelIndex: number;
  levelName: string;
} {
  const raw        = Math.floor(Math.sqrt(Math.max(0, totalXP) / 100));
  const levelIndex = Math.min(raw, LEVEL_NAMES.length - 1);
  return { levelIndex, levelName: LEVEL_NAMES[levelIndex] };
}

// ── Service functions ──────────────────────────────────────────────────────────

export async function submitDay(
  userId: string,
  input: SubmitDayInput
): Promise<SubmitDayResult> {
  const { date, completedWeight, totalWeight, streak } = input;

  const score   = calculateScore(completedWeight, totalWeight, streak);
  const xpEarned = calculateXP(completedWeight, totalWeight, streak);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get previous submission for this date (for XP delta on re-submission)
    const previous = await getPreviousDailyScore(client, userId, date);
    const previousXP = previous?.xp_earned ?? 0;

    // Persist the day's score
    await upsertDailyScore(client, userId, date, score, xpEarned);

    // Fetch current identity (or bootstrap a zero-XP one)
    const currentIdentity = await getIdentity(userId, DOMAIN);
    const currentTotalXP  = currentIdentity?.total_xp ?? 0;
    const previousLevelIndex = currentIdentity?.level_index ?? 0;

    // Apply XP delta so re-submissions don't double-count
    const newTotalXP  = Math.max(0, currentTotalXP - previousXP + xpEarned);
    const { levelIndex, levelName } = getLevelFromXP(newTotalXP);

    await upsertIdentity(client, userId, DOMAIN, newTotalXP, levelIndex, levelName);

    await client.query('COMMIT');

    return {
      score,
      xpEarned,
      totalXP:      Math.round(newTotalXP * 100) / 100,
      levelIndex,
      levelName,
      levelChanged: levelIndex !== previousLevelIndex,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getIdentityForUser(
  userId: string
): Promise<UserIdentity | null> {
  return getIdentity(userId, DOMAIN);
}

export async function getLeaderboardForDate(
  date: string
): Promise<LeaderboardEntry[]> {
  return getLeaderboard(date);
}
