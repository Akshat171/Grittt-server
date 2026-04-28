import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Helper: normalize habit name (lowercase & collapse whitespace)
function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Compute streak length from an array of completion dates (Date objects) ordered desc
function computeStreakFromDates(dates: Date[]) {
  if (!dates || dates.length === 0) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build a set of ISO date strings for fast lookup
  const set = new Set(dates.map(d => d.toISOString().slice(0, 10)));

  let streak = 0;
  let cursor = new Date(today);
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    if (set.has(key)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

// GET /api/habits/:name/ranking
// Returns list of users who have the same habit name, ordered by current streak desc.
router.get('/:name/ranking', requireAuth, async (req: Request, res: Response) => {
  const rawName = String(req.params.name ?? '');
  if (!rawName) return res.status(400).json({ error: 'Missing habit name' });
  const name = normalizeName(rawName);
  const limit = Number(req.query.limit ?? 50);

  try {
    const client = await pool.connect();
    try {
      // Get users who have a task with this normalized name
      const tasksRes = await client.query(
        `SELECT t.user_id, u.name AS user_name, u.avatar_url
         FROM tasks t
         JOIN users u ON u.id = t.user_id
         WHERE t.normalized_name = $1 AND t.archived_at IS NULL
         GROUP BY t.user_id, u.name, u.avatar_url`,
        [name]
      );

      const rows = tasksRes.rows;

      // For each user, fetch recent completions for this normalized_name and compute streak
      const results = [] as any[];
      for (const r of rows) {
        const userId = r.user_id;
        const cRes = await client.query(
          `SELECT date FROM habit_completions WHERE user_id = $1 AND normalized_name = $2 AND date <= CURRENT_DATE ORDER BY date DESC LIMIT 365`,
          [userId, name]
        );
        const dates = cRes.rows.map((rr: any) => new Date(rr.date));
        const streak = computeStreakFromDates(dates);
        results.push({ userId, userName: r.user_name, avatar: r.avatar_url, streak });
      }

      // Sort by streak desc
      results.sort((a, b) => b.streak - a.streak);

      res.json({ name: rawName, normalized: name, ranking: results.slice(0, limit) });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to compute habit ranking:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/habits/:name/completions/today
// Returns how many distinct users completed this habit today
router.get('/:name/completions/today', requireAuth, async (req: Request, res: Response) => {
  const rawName = String(req.params.name ?? '');
  if (!rawName) return res.status(400).json({ error: 'Missing habit name' });
  const name = normalizeName(rawName);

  try {
    const client = await pool.connect();
    try {
      const cntRes = await client.query(
        `SELECT COUNT(DISTINCT user_id) AS count FROM habit_completions WHERE normalized_name = $1 AND date = CURRENT_DATE`,
        [name]
      );
      const count = Number(cntRes.rows[0]?.count ?? 0);
      res.json({ name: rawName, normalized: name, count });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to count habit completions today:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/habits/:name/completions
// Record that the current user completed the habit today. Idempotent.
router.post('/:name/completions', requireAuth, async (req: Request, res: Response) => {
  const rawName = String(req.params.name ?? '');
  if (!rawName) return res.status(400).json({ error: 'Missing habit name' });
  const name = normalizeName(rawName);
  const userId = (req as any).userId as string;
  const taskId = req.body?.taskId ?? null;
  const taskName = req.body?.taskName ?? rawName;
  const completionType = req.body?.completionType ?? 'full';

  try {
    const client = await pool.connect();
    try {
      // Delete existing completion for today first (in case switching between full/tiny)
      await client.query(
        `DELETE FROM habit_completions WHERE user_id = $1 AND normalized_name = $2 AND date = CURRENT_DATE`,
        [userId, name]
      );
      await client.query(
        `INSERT INTO habit_completions (user_id, task_id, task_name, normalized_name, date, completion_type)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)`,
        [userId, taskId, taskName, name, completionType]
      );
      res.status(201).json({ ok: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to insert habit completion:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/habits/:name/completions
// Remove today's completion for the current user (if present)
router.delete('/:name/completions', requireAuth, async (req: Request, res: Response) => {
  const rawName = String(req.params.name ?? '');
  if (!rawName) return res.status(400).json({ error: 'Missing habit name' });
  const name = normalizeName(rawName);
  const userId = (req as any).userId as string;

  try {
    await pool.query(`DELETE FROM habit_completions WHERE user_id = $1 AND normalized_name = $2 AND date = CURRENT_DATE`, [userId, name]);
    res.status(204).send();
  } catch (err) {
    console.error('Failed to delete habit completion:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/habits/:name/score?date=YYYY-MM-DD
// Returns the habit's points for the current user on the specified date (or today)
router.get('/:name/score', requireAuth, async (req: Request, res: Response) => {
  const rawName = String(req.params.name ?? '');
  if (!rawName) return res.status(400).json({ error: 'Missing habit name' });
  const name = normalizeName(rawName);
  const dateStr = String(req.query.date ?? '');
  const date = dateStr ? new Date(dateStr) : new Date();
  date.setHours(0, 0, 0, 0);
  const userId = (req as any).userId as string;

  const STREAK_FACTOR = Number(process.env.DEFAULT_STREAK_FACTOR ?? process.env.VITE_STREAK_FACTOR ?? 0);
  const SKIP_PENALTY = Number(process.env.DEFAULT_SKIP_PENALTY ?? process.env.VITE_SKIP_PENALTY ?? 0.1);

  try {
    const client = await pool.connect();
    try {
      // Find the user's task matching normalized_name
      const tRes = await client.query(`SELECT id, name, score, days FROM tasks WHERE user_id = $1 AND normalized_name = $2 AND archived_at IS NULL LIMIT 1`, [userId, name]);
      const task = tRes.rows[0];
      if (!task) return res.json({ name: rawName, normalized: name, score: null });

      // parse days
      const days = task.days ?? [];
      // compute dayOfWeek label for the date using server-side mapping: Mon..Sun
      const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][date.getDay() === 0 ? 6 : date.getDay() - 1];
      const isScheduled = (days as any).includes(dow);
      if (!isScheduled) return res.json({ name: rawName, normalized: name, score: null });

      // check if completed on the date
      const cRes = await client.query(`SELECT date FROM habit_completions WHERE user_id = $1 AND normalized_name = $2 AND date <= $3 ORDER BY date DESC LIMIT 365`, [userId, name, date]);
      const dates = cRes.rows.map((r: any) => new Date(r.date));
      // compute streak using existing helper
      const streak = computeStreakFromDates(dates);

      const doneRes = await client.query(`SELECT 1 FROM habit_completions WHERE user_id = $1 AND normalized_name = $2 AND date = $3 LIMIT 1`, [userId, name, date]);
      const done = doneRes.rows.length > 0;

      if (done) {
        const pts = Number(task.score) + (streak * STREAK_FACTOR);
        return res.json({ name: rawName, normalized: name, score: Math.round(pts * 100) / 100, done: true, streak });
      }

      const penalized = Number(task.score) * (1 - (SKIP_PENALTY || 0));
      return res.json({ name: rawName, normalized: name, score: Math.round(penalized * 100) / 100, done: false, streak });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to compute habit score:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/habits/score/day?date=YYYY-MM-DD
// Returns the user's day score aggregated from scheduled tasks
router.get('/score/day', requireAuth, async (req: Request, res: Response) => {
  const dateStr = String(req.query.date ?? '');
  const date = dateStr ? new Date(dateStr) : new Date();
  date.setHours(0, 0, 0, 0);
  const userId = (req as any).userId as string;

  const STREAK_FACTOR = Number(process.env.DEFAULT_STREAK_FACTOR ?? process.env.VITE_STREAK_FACTOR ?? 0);

  try {
    const client = await pool.connect();
    try {
      // fetch scheduled tasks for the user on that date
      const allRes = await client.query(`SELECT id, name, score, days, normalized_name FROM tasks WHERE user_id = $1 AND archived_at IS NULL`, [userId]);
      const tasks = allRes.rows.map((r: any) => ({ ...r }));

      // Determine day label
      const dow = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][date.getDay() === 0 ? 6 : date.getDay() - 1];
      const scheduled = tasks.filter((t: any) => (t.days || []).includes(dow));
      if (scheduled.length === 0) return res.json({ date: date.toISOString().slice(0,10), score: null });

      // fetch today's completions for user
      const cRes = await client.query(`SELECT normalized_name, date FROM habit_completions WHERE user_id = $1 AND date = $2`, [userId, date]);
      const completedNames = new Set(cRes.rows.map((r: any) => r.normalized_name));

      const totalPossible = scheduled.reduce((s: number, t: any) => s + Number(t.score), 0);
      if (totalPossible === 0) return res.json({ date: date.toISOString().slice(0,10), score: 0 });

      const baseEarned = scheduled.filter((t: any) => completedNames.has(t.normalized_name)).reduce((s: number, t: any) => s + Number(t.score), 0);
      const basePercent = (baseEarned / totalPossible) * 100;

      // total streak bonus: for each completed scheduled task compute streak and bonus
      let totalBonus = 0;
      for (const t of scheduled) {
        if (!completedNames.has(t.normalized_name)) continue;
        // fetch last year completions for this task
        const cr = await client.query(`SELECT date FROM habit_completions WHERE user_id = $1 AND normalized_name = $2 AND date <= $3 ORDER BY date DESC LIMIT 365`, [userId, t.normalized_name, date]);
        const dates = cr.rows.map((r: any) => new Date(r.date));
        const streak = computeStreakFromDates(dates);
        totalBonus += streak * STREAK_FACTOR;
      }

      const final = (Math.round(basePercent * 100) / 100) + (Math.round(totalBonus * 100) / 100);
      return res.json({ date: date.toISOString().slice(0,10), score: Math.round(final * 100) / 100 });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to compute day score:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Streak Shields ─────────────────────────────────────────────────────────────
const MAX_SHIELDS_PER_MONTH = 2;

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// GET /api/habits/shields - get shields used this month & remaining
router.get('/shields', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const monthKey = currentMonthKey();
  try {
    const r = await pool.query(
      `SELECT used_date FROM streak_shields WHERE user_id = $1 AND month_key = $2 ORDER BY used_date`,
      [userId, monthKey]
    );
    const used = r.rows.map((row: any) => row.used_date);
    res.json({ monthKey, used, remaining: MAX_SHIELDS_PER_MONTH - used.length, max: MAX_SHIELDS_PER_MONTH });
  } catch (err) {
    console.error('GET /api/habits/shields failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/habits/shields/use - use a shield for a specific date
router.post('/shields/use', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { date } = req.body; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'Missing date' });
  const monthKey = currentMonthKey();
  try {
    // Check if already used for this date
    const existing = await pool.query(
      `SELECT 1 FROM streak_shields WHERE user_id = $1 AND used_date = $2`,
      [userId, date]
    );
    if (existing.rows.length > 0) return res.json({ ok: true, alreadyUsed: true });

    // Check remaining
    const countRes = await pool.query(
      `SELECT COUNT(*) as cnt FROM streak_shields WHERE user_id = $1 AND month_key = $2`,
      [userId, monthKey]
    );
    const usedCount = Number(countRes.rows[0].cnt);
    if (usedCount >= MAX_SHIELDS_PER_MONTH) {
      return res.status(400).json({ error: 'No shields remaining this month' });
    }

    await pool.query(
      `INSERT INTO streak_shields (user_id, used_date, month_key) VALUES ($1, $2, $3)`,
      [userId, date, monthKey]
    );
    res.status(201).json({ ok: true, remaining: MAX_SHIELDS_PER_MONTH - usedCount - 1 });
  } catch (err) {
    console.error('POST /api/habits/shields/use failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Bad Day Sync ───────────────────────────────────────────────────────────────

// POST /api/habits/bad-day - log a bad day
router.post('/bad-day', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Missing date' });
  try {
    await pool.query(
      `INSERT INTO bad_day_logs (user_id, date) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING`,
      [userId, date]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /api/habits/bad-day failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/habits/bad-day - remove bad day
router.delete('/bad-day', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const date = req.query.date as string;
  if (!date) return res.status(400).json({ error: 'Missing date' });
  try {
    await pool.query(`DELETE FROM bad_day_logs WHERE user_id = $1 AND date = $2`, [userId, date]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/habits/bad-day failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── AI Habit Coach ─────────────────────────────────────────────────────────────

// POST /api/habits/ai/weekly-debrief
// Generates a personalized weekly habit summary using Claude
router.post('/ai/weekly-debrief', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  try {
    const client = await pool.connect();
    try {
      // Fetch user's tasks
      const tasksRes = await client.query(
        `SELECT name, score, days, category, tiny_version, why_started FROM tasks WHERE user_id = $1 AND archived_at IS NULL`,
        [userId]
      );
      const tasks = tasksRes.rows;

      // Fetch last 14 days of completions
      const compRes = await client.query(
        `SELECT task_name, normalized_name, date, completion_type
         FROM habit_completions WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '14 days'
         ORDER BY date`,
        [userId]
      );
      const completions = compRes.rows;

      // Fetch bad days
      const badRes = await client.query(
        `SELECT date FROM bad_day_logs WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '14 days'`,
        [userId]
      );
      const badDays = badRes.rows.map((r: any) => r.date);

      // Fetch shield usage
      const shieldRes = await client.query(
        `SELECT used_date FROM streak_shields WHERE user_id = $1 AND month_key = $2`,
        [userId, currentMonthKey()]
      );
      const shields = shieldRes.rows;

      // Build data summary for AI
      const tasksSummary = tasks.map((t: any) =>
        `- ${t.name} (${t.category}, ${t.score}pts, scheduled: ${JSON.parse(JSON.stringify(t.days)).join(',')}${t.tiny_version ? `, tiny: "${t.tiny_version}"` : ''}${t.why_started ? `, why: "${t.why_started}"` : ''})`
      ).join('\n');

      const compSummary = completions.map((c: any) =>
        `${c.date}: ${c.task_name} (${c.completion_type})`
      ).join('\n');

      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const prompt = `You are a supportive, insightful habit coach. Analyze this user's habit data and generate a personalized weekly debrief.

HABITS:
${tasksSummary}

COMPLETIONS (last 14 days):
${compSummary || 'No completions recorded.'}

BAD DAYS: ${badDays.length > 0 ? badDays.join(', ') : 'None'}
SHIELDS USED THIS MONTH: ${shields.length}/${MAX_SHIELDS_PER_MONTH}

Rules:
1. Be honest but NEVER harsh. Frame everything constructively.
2. Identify ONE specific pattern the user might not notice themselves.
3. If they used "Bad Day" mode, praise them for showing up small instead of quitting.
4. Reference their "why" motivation if they have one — remind them of their own words.
5. Give ONE specific, actionable suggestion for next week.
6. Use identity-based language: "You ARE someone who..." not "You should try to..."
7. Keep it under 150 words total.

Return ONLY JSON: {"summary": "...", "pattern": "...", "suggestion": "...", "identity": "..."}`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });

      const raw = completion.choices[0]?.message?.content ?? '{}';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      res.json({
        summary: parsed.summary ?? '',
        pattern: parsed.pattern ?? '',
        suggestion: parsed.suggestion ?? '',
        identity: parsed.identity ?? '',
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('AI weekly debrief error:', err?.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// POST /api/habits/ai/recovery-nudge
// When a user misses a habit, get a personalized recovery message
router.post('/ai/recovery-nudge', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { habitName, streak, momentum, tinyVersion, whyStarted } = req.body;
  if (!habitName) return res.status(400).json({ error: 'Missing habitName' });

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `You are a supportive habit coach. The user missed their habit "${habitName}" yesterday.

Context:
- Current streak before miss: ${streak ?? 0} days
- Momentum score: ${momentum ?? 0}%
${tinyVersion ? `- They have a tiny version: "${tinyVersion}"` : ''}
${whyStarted ? `- Their motivation: "${whyStarted}"` : ''}

Generate a short, warm recovery nudge (2-3 sentences max). Rules:
1. NEVER say "you failed" or make them feel guilty
2. If they have a tiny version, suggest doing that today
3. Reference their momentum score — one day barely dents it
4. If they have a "why", subtly reference it
5. Use identity-based framing: "You're still someone who..."

Return ONLY JSON: {"nudge": "...", "suggestTiny": true/false}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({ nudge: parsed.nudge ?? '', suggestTiny: parsed.suggestTiny ?? false });
  } catch (err: any) {
    console.error('AI recovery nudge error:', err?.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// POST /api/habits/ai/patterns
// Analyze 30 days of data for non-obvious correlations
router.post('/ai/patterns', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  try {
    const client = await pool.connect();
    try {
      const tasksRes = await client.query(
        `SELECT name, score, days, category FROM tasks WHERE user_id = $1 AND archived_at IS NULL`,
        [userId]
      );

      const compRes = await client.query(
        `SELECT task_name, date, completion_type
         FROM habit_completions WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY date`,
        [userId]
      );

      const badRes = await client.query(
        `SELECT date FROM bad_day_logs WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'`,
        [userId]
      );

      if (compRes.rows.length < 7) {
        return res.json({ patterns: [], message: 'Need at least 7 days of data for pattern detection.' });
      }

      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const tasksList = tasksRes.rows.map((t: any) => `${t.name} (${t.category})`).join(', ');
      const compList = compRes.rows.map((c: any) => `${c.date}: ${c.task_name} (${c.completion_type})`).join('\n');
      const badDays = badRes.rows.map((r: any) => r.date).join(', ');

      const prompt = `You are a behavioral data analyst. Analyze this user's 30-day habit data and find patterns they might not see.

HABITS: ${tasksList}

COMPLETIONS:
${compList}

BAD DAYS: ${badDays || 'None'}

Find 2-3 specific, non-obvious patterns. Examples:
- "You complete gym habits 90% on Monday/Wednesday but only 40% on Friday"
- "Your best streaks happen when you complete morning habits before 10am"
- "You tend to miss habits the day after a bad day — consider using tiny versions on recovery days"

Return ONLY JSON: {"patterns": [{"insight": "...", "actionable": "..."}]}
Each pattern needs: insight (what you found) and actionable (what to do about it).`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });

      const raw = completion.choices[0]?.message?.content ?? '{}';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      res.json({ patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [] });
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('AI patterns error:', err?.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

export default router;

