import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { submitFullDay } from '../services/score';

const router = Router();

router.use(requireAuth);

// ── Schema ─────────────────────────────────────────────────────────────────────

const SubmitFullDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),

  discipline: z.object({
    buildCompleted:  z.number().min(0),
    buildTotal:      z.number().min(0),
    controlResisted: z.number().min(0),
    controlTotal:    z.number().min(0),
  }).refine(d => d.buildCompleted <= d.buildTotal, {
    message: 'buildCompleted cannot exceed buildTotal',
    path: ['buildCompleted'],
  }).refine(d => d.controlResisted <= d.controlTotal, {
    message: 'controlResisted cannot exceed controlTotal',
    path: ['controlResisted'],
  }),

  strength: z.object({
    consistency: z.number().min(0).max(100),
    effort:      z.number().min(0).max(100),
  }),

  food: z.object({
    calorieAccuracy:  z.number().min(0).max(100),
    proteinScore:     z.number().min(0).max(100),
    consistencyScore: z.number().min(0).max(100),
  }),

  streak: z.number().int().min(0),
});

// ── POST /api/score/submit-day ─────────────────────────────────────────────────

router.post('/submit-day', async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;

  const parsed = SubmitFullDaySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await submitFullDay(userId, parsed.data);
    res.json(result);
  } catch (err) {
    console.error('score/submit-day error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
