import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { requireAuth } from '../middleware/auth';

const router = Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── POST /api/ai/food-coach ────────────────────────────────────────────────────
// Body: { dailyLogs: [{date, calories, protein, carbs, fats}], calorieGoal, proteinGoal }
// Returns: { tips: string[] }

router.post('/food-coach', requireAuth, async (req: Request, res: Response) => {
  const { dailyLogs, calorieGoal, proteinGoal } = req.body;

  if (!dailyLogs || !Array.isArray(dailyLogs)) {
    res.status(400).json({ error: 'dailyLogs array is required' });
    return;
  }

  const logsText = dailyLogs
    .map((d: any) =>
      `${d.date}: ${d.calories} kcal (goal ${calorieGoal}), protein ${d.protein}g (goal ${proteinGoal}g), carbs ${d.carbs}g, fats ${d.fats}g`
    )
    .join('\n');

  const prompt = `You are a concise, no-nonsense nutrition coach.
The user's daily goals are ${calorieGoal} kcal and ${proteinGoal}g protein.

Here are their last ${dailyLogs.length} days of nutrition data:
${logsText}

Give exactly 3 short, actionable tips based on this data.
Each tip must be 1-2 sentences max. Be specific, use their actual numbers.
No intros, no fluff. Return ONLY a JSON object: {"tips": ["tip1", "tip2", "tip3"]}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    const tips: string[] = Array.isArray(parsed.tips) ? parsed.tips : [];

    res.json({ tips: tips.slice(0, 3) });
  } catch (err: any) {
    console.error('AI food-coach error:', err?.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// ── POST /api/ai/workout ───────────────────────────────────────────────────────
// Body: { levelName, levelIndex, totalXP, workoutDaysPerWeek, recentSessions: [{date, completedWeight, totalWeight, effort}] }
// Returns: { plan: [{ day: string, focus: string, exercises: string[] }] }

router.post('/workout', requireAuth, async (req: Request, res: Response) => {
  const { levelName, levelIndex, totalXP, workoutDaysPerWeek, recentSessions } = req.body;

  const sessionsText = recentSessions && recentSessions.length > 0
    ? recentSessions
        .map((s: any) => `${s.date}: ${s.completedWeight}kg / ${s.totalWeight}kg (${s.effort}% effort)`)
        .join('\n')
    : 'No recent sessions logged yet.';

  const prompt = `You are an expert strength coach.
The user's current level: ${levelName} (Level ${(levelIndex ?? 0) + 1}), ${totalXP ?? 0} total XP.
They want to train ${workoutDaysPerWeek ?? 4} days per week.

Recent sessions:
${sessionsText}

Generate a ${workoutDaysPerWeek ?? 4}-day weekly workout plan tailored to their level.
Keep it practical and progressive. Each day should have a focus (e.g. "Push - Chest & Triceps") and 4-5 exercises with sets x reps.

Return ONLY this JSON (no extra text):
{
  "plan": [
    { "day": "Day 1", "focus": "...", "exercises": ["Exercise - sets x reps", ...] },
    ...
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({ plan: parsed.plan ?? [] });
  } catch (err: any) {
    console.error('AI workout error:', err?.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// ── POST /api/ai/snap-track ───────────────────────────────────────────────────
// Body: { imageBase64: string }   (data URI or raw base64, jpeg/png)
// Returns: { name, calories, protein, carbs, fats, servingNote }

router.post('/snap-track', requireAuth, async (req: Request, res: Response) => {
  const { imageBase64 } = req.body;

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 is required' });
    return;
  }

  // Accept either a raw base64 string or a data URI (data:image/jpeg;base64,...)
  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const mimeType   = imageBase64.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

  const prompt = `You are a precise nutrition analyst. Look at this food image and estimate its nutritional content.
Return ONLY a JSON object with these exact fields (numbers only, no units in values):
{
  "name": "descriptive food name",
  "calories": number,
  "protein": number (grams),
  "carbs": number (grams),
  "fats": number (grams),
  "servingNote": "brief note about estimated portion size"
}
If you cannot identify food in the image, return { "error": "No food detected" }.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}`, detail: 'low' } },
          ],
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { res.status(500).json({ error: 'AI returned unexpected format' }); return; }

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.error) { res.status(422).json({ error: parsed.error }); return; }

    res.json({
      name:        String(parsed.name        ?? 'Unknown food'),
      calories:    Number(parsed.calories    ?? 0),
      protein:     Number(parsed.protein     ?? 0),
      carbs:       Number(parsed.carbs       ?? 0),
      fats:        Number(parsed.fats        ?? 0),
      servingNote: String(parsed.servingNote ?? ''),
    });
  } catch (err: any) {
    console.error('snap-track error:', err?.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

export default router;
