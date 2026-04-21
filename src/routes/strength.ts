import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  submitDay,
  getIdentityForUser,
  getLeaderboardForDate,
  LEVEL_NAMES,
  getLevelFromXP,
} from '../services/strength';

const router = Router();

// All strength routes require authentication
router.use(requireAuth);

// ── Schemas ────────────────────────────────────────────────────────────────────

const SubmitDaySchema = z.object({
  date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  completedWeight: z.number().min(0),
  totalWeight:     z.number().min(0),
  streak:          z.number().int().min(0),
});

const DateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
});

// ── POST /api/strength/submit-day ──────────────────────────────────────────────

router.post('/submit-day', async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;

  const parsed = SubmitDaySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }

  const { date, completedWeight, totalWeight, streak } = parsed.data;

  if (completedWeight > totalWeight) {
    res.status(400).json({ error: 'completedWeight cannot exceed totalWeight' });
    return;
  }

  const result = await submitDay(userId, { date, completedWeight, totalWeight, streak });

  res.json(result);
});

// ── GET /api/strength/identity ─────────────────────────────────────────────────

router.get('/identity', async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;

  const identity = await getIdentityForUser(userId);

  if (!identity) {
    // Return a bootstrapped zero-state for users who haven't submitted yet
    const { levelIndex, levelName } = getLevelFromXP(0);
    res.json({
      totalXP:    0,
      levelIndex,
      levelName,
      nextLevel:  LEVEL_NAMES[levelIndex + 1] ?? null,
      xpToNext:   levelIndex < LEVEL_NAMES.length - 1
        ? Math.pow(levelIndex + 1, 2) * 100
        : null,
    });
    return;
  }

  const nextLevelIndex = identity.level_index + 1;
  const xpToNext = nextLevelIndex < LEVEL_NAMES.length
    ? Math.pow(nextLevelIndex, 2) * 100 - identity.total_xp
    : null;

  res.json({
    totalXP:    Math.round(identity.total_xp * 100) / 100,
    levelIndex: identity.level_index,
    levelName:  identity.level_name,
    nextLevel:  LEVEL_NAMES[nextLevelIndex] ?? null,
    xpToNext:   xpToNext !== null ? Math.max(0, Math.round(xpToNext * 100) / 100) : null,
    updatedAt:  identity.updated_at,
  });
});

// ── GET /api/strength/leaderboard?date=YYYY-MM-DD ─────────────────────────────

router.get('/leaderboard', async (req: Request, res: Response) => {
  const parsed = DateQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid date query param', details: parsed.error.flatten() });
    return;
  }

  const entries = await getLeaderboardForDate(parsed.data.date);

  res.json({ date: parsed.data.date, leaderboard: entries });
});

export default router;
