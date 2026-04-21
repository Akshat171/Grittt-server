import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { submitFuelDay, getFuelIdentity, FuelDayInput } from '../services/fuelService';

const router = Router();

// POST /api/fuel/submit-day
router.post('/submit-day', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const input = req.body as FuelDayInput;

    // Basic validation
    if (!input || !input.date) return res.status(400).json({ error: 'Missing input or date' });

    // sanitize numeric inputs
    const normalized = {
      date: String(input.date),
      caloriesConsumed: Number(input.caloriesConsumed ?? 0),
      calorieTarget: Number(input.calorieTarget ?? 0),
      protein: Number(input.protein ?? 0),
      proteinTarget: Number(input.proteinTarget ?? 0),
      mealsLogged: Number(input.mealsLogged ?? 0),
      expectedMeals: Number(input.expectedMeals ?? 0),
      junkMeals: Number(input.junkMeals ?? 0),
    } as FuelDayInput;

    const result = await submitFuelDay(userId, normalized);
    res.json(result);
  } catch (err: any) {
    console.error('POST /api/fuel/submit-day error', err);
    res.status(500).json({ error: err.message ?? 'Server error' });
  }
});

// GET /api/fuel/identity
router.get('/identity', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const identity = await getFuelIdentity(userId);
    res.json(identity);
  } catch (err) {
    console.error('GET /api/fuel/identity error', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
