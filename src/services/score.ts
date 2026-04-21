import { pool } from '../db/pool';
import {
  getIdentity,
  upsertIdentity,
  upsertFullDailyScore,
  getPreviousFullDailyScore,
} from '../db/identity';
import { getLevelFromXP } from './strength';
import { SubmitFullDayInput, SubmitFullDayResult } from '../types';

const SCORE_DOMAIN = 'Overall' as const;

// ── Helpers ────────────────────────────────────────────────────────────────────

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

// ── Pure scoring functions ─────────────────────────────────────────────────────

/**
 * Discipline score (0–100)
 *
 * buildScore    = buildCompleted / buildTotal           (0–1)
 * controlScore  = controlResisted / controlTotal        (0–1)
 * final         = (buildScore × 0.6 + controlScore × 0.4) × 100
 */
export function calculateDisciplineScore(
  buildCompleted: number,
  buildTotal: number,
  controlResisted: number,
  controlTotal: number
): number {
  const buildScore   = safeDivide(buildCompleted, buildTotal);
  const controlScore = safeDivide(controlResisted, controlTotal);
  const raw = (buildScore * 0.6 + controlScore * 0.4) * 100;
  return clamp(round2(raw));
}

/**
 * Strength score (0–100)
 *
 * final = consistency × 60 + effort × 40
 *
 * consistency and effort are expected as fractions (0–1) or percentages (0–100).
 * If values are > 1 they are treated as percentages and normalised.
 */
export function calculateStrengthScore(
  consistency: number,
  effort: number
): number {
  const c = consistency > 1 ? consistency / 100 : consistency;
  const e = effort      > 1 ? effort      / 100 : effort;
  const raw = clamp(c) * 60 + clamp(e) * 40;
  return clamp(round2(raw));
}

/**
 * Food score (0–100)
 *
 * final = calorieAccuracy × 40 + proteinScore × 30 + consistencyScore × 30
 *
 * Inputs are expected as fractions (0–1) or percentages (0–100).
 */
export function calculateFoodScore(
  calorieAccuracy: number,
  proteinScore: number,
  consistencyScore: number
): number {
  const ca = calorieAccuracy  > 1 ? calorieAccuracy  / 100 : calorieAccuracy;
  const ps = proteinScore     > 1 ? proteinScore     / 100 : proteinScore;
  const cs = consistencyScore > 1 ? consistencyScore / 100 : consistencyScore;
  const raw = clamp(ca) * 40 + clamp(ps) * 30 + clamp(cs) * 30;
  return clamp(round2(raw));
}

/**
 * Final composite score (0–100)
 *
 * final = discipline × 0.5 + strength × 0.3 + food × 0.2
 */
export function calculateFinalScore(
  discipline: number,
  strength: number,
  food: number
): number {
  const raw = discipline * 0.5 + strength * 0.3 + food * 0.2;
  return clamp(round2(raw));
}

/**
 * XP earned for the day
 *
 * xp = finalScore × 1.5 + streak × 5
 */
export function calculateXP(finalScore: number, streak: number): number {
  const raw = finalScore * 1.5 + streak * 5;
  return round2(Math.max(0, raw));
}

// ── Service function ───────────────────────────────────────────────────────────

export async function submitFullDay(
  userId: string,
  input: SubmitFullDayInput
): Promise<SubmitFullDayResult> {
  const { date, discipline, strength, food, streak } = input;

  // Compute all scores
  const disciplineScore = calculateDisciplineScore(
    discipline.buildCompleted,
    discipline.buildTotal,
    discipline.controlResisted,
    discipline.controlTotal
  );
  const strengthScore = calculateStrengthScore(strength.consistency, strength.effort);
  const foodScore     = calculateFoodScore(food.calorieAccuracy, food.proteinScore, food.consistencyScore);
  const finalScore    = calculateFinalScore(disciplineScore, strengthScore, foodScore);
  const xpEarned      = calculateXP(finalScore, streak);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch previous submission for this date so XP delta is correct on re-submission
    const previous      = await getPreviousFullDailyScore(client, userId, date);
    const previousXP    = previous?.composite_xp_earned ?? 0;

    // Upsert the full daily score row
    await upsertFullDailyScore(
      client,
      userId,
      date,
      disciplineScore,
      strengthScore,
      foodScore,
      finalScore,
      xpEarned
    );

    // Update user_identity XP (delta approach prevents double-counting on re-submission)
    const currentIdentity    = await getIdentity(userId, SCORE_DOMAIN);
    const currentTotalXP     = currentIdentity?.total_xp ?? 0;
    const previousLevelIndex = currentIdentity?.level_index ?? 0;

    const newTotalXP = Math.max(0, currentTotalXP - previousXP + xpEarned);
    const { levelIndex, levelName } = getLevelFromXP(newTotalXP);

    await upsertIdentity(client, userId, SCORE_DOMAIN, newTotalXP, levelIndex, levelName);

    await client.query('COMMIT');

    return {
      disciplineScore,
      strengthScore,
      foodScore,
      finalScore,
      xpEarned,
      totalXP:      round2(newTotalXP),
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
