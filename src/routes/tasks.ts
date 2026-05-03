import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

const TASK_FIELDS = `id, name, normalized_name, score, days, archived_at, start_date, category, tiny_version, why_started, created_at, updated_at`;

// GET /api/tasks - user tasks
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  try {
    const r = await pool.query(
      `SELECT ${TASK_FIELDS} FROM tasks WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /api/tasks failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Habit slot limit based on account age
function getMaxHabits(createdAt: Date): number {
  const days = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 7) return 3;
  if (days < 14) return 5;
  if (days < 21) return 6;
  return 8;
}

// POST /api/tasks - create a task
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const { name, score = 0, days = [], category = 'build', startDate = null, tinyVersion = null, whyStarted = null } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const normalized_name = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
  try {
    // Enforce server-side habit limit
    const userRes = await pool.query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
    const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM tasks WHERE user_id = $1 AND archived_at IS NULL`, [userId]);
    const activeCount = Number(countRes.rows[0].cnt);
    const maxHabits = userRes.rows[0] ? getMaxHabits(new Date(userRes.rows[0].created_at)) : 3;
    if (activeCount >= maxHabits) {
      return res.status(400).json({ error: `Habit limit reached (${maxHabits}). Keep going to unlock more!` });
    }

    const r = await pool.query(
      `INSERT INTO tasks (user_id, name, normalized_name, score, days, category, start_date, tiny_version, why_started)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${TASK_FIELDS}`,
      [userId, name, normalized_name, score, JSON.stringify(days), category, startDate, tinyVersion, whyStarted]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('POST /api/tasks failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/tasks/:id - update task
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = req.params.id;
  const { name, score, days, archived, category, startDate } = req.body;
  try {
    const fields = [] as string[];
    const values = [] as any[];
    let idx = 1;
    if (name     !== undefined) { fields.push(`name = $${idx++}`);       values.push(name); }
    if (score    !== undefined) { fields.push(`score = $${idx++}`);      values.push(score); }
    if (days     !== undefined) { fields.push(`days = $${idx++}`);       values.push(JSON.stringify(days)); }
    if (archived !== undefined) { fields.push(`archived_at = $${idx++}`); values.push(archived ? 'now()' : null); }
    if (category !== undefined) { fields.push(`category = $${idx++}`);   values.push(category); }
    if (startDate !== undefined) { fields.push(`start_date = $${idx++}`); values.push(startDate); }
    if (req.body.tinyVersion !== undefined) { fields.push(`tiny_version = $${idx++}`); values.push(req.body.tinyVersion); }
    if (req.body.whyStarted !== undefined) { fields.push(`why_started = $${idx++}`); values.push(req.body.whyStarted); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING ${TASK_FIELDS}`;
    values.push(id, userId);
    const r = await pool.query(sql, values);
    res.json(r.rows[0] ?? null);
  } catch (err) {
    console.error('PUT /api/tasks/:id failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/tasks/:id - delete task
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = req.params.id;
  try {
    await pool.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [id, userId]);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/tasks/:id failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
