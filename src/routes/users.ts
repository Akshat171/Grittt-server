import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { findUserById } from '../db/users';

const router = Router();

router.get('/profile', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;
  const user = await findUserById(userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at });
});

export default router;
