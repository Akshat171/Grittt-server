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

  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO habit_completions (user_id, task_id, task_name, normalized_name, date)
         SELECT $1, $2, $3, $4, CURRENT_DATE
         WHERE NOT EXISTS (
           SELECT 1 FROM habit_completions WHERE user_id = $1 AND normalized_name = $4 AND date = CURRENT_DATE
         )`,
        [userId, taskId, taskName, name]
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

export default router;

