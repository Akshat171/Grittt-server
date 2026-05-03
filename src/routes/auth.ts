import { Router, Request, Response } from 'express';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { findUserByEmail, createUser, findUserById, upsertGoogleUser } from '../db/users';
import { signToken, setTokenCookie, requireAuth } from '../middleware/auth';

const router = Router();

// ── Schemas ────────────────────────────────────────────────────────────────────

const SignupSchema = z.object({
  name:     z.string().min(1).max(100),
  email:    z.string().email(),
  password: z.string().min(8).max(128),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

// ── Local signup ───────────────────────────────────────────────────────────────

router.post('/signup', async (req: Request, res: Response) => {
  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }

  const { name, email, password } = parsed.data;

  const existing = await findUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: 'Email already in use' });
    return;
  }

  const password_hash = await bcrypt.hash(password, 12);
  const user = await createUser({ email, name, password_hash });

  const token = signToken({ userId: user.id, email: user.email });
  setTokenCookie(res, token);

  res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at },
    token,
  });
});

// ── Local login ────────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }

  const { email, password } = parsed.data;
  const user = await findUserByEmail(email);

  if (!user || !user.password_hash) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signToken({ userId: user.id, email: user.email });
  setTokenCookie(res, token);

  res.json({
    user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at },
    token,
  });
});

// ── Logout ─────────────────────────────────────────────────────────────────────

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token', { path: '/' });
  res.json({ message: 'Logged out' });
});

// ── Current user ───────────────────────────────────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as Request & { userId: string }).userId;
  const user = await findUserById(userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url });
});

// ── Google OAuth — Mobile access-token verification ───────────────────────────
// The mobile app uses expo-auth-session to get a Google access token directly,
// then sends it here. We verify it with Google's userinfo endpoint and return a JWT.

router.post('/google/verify-token', async (req: Request, res: Response) => {
  const { accessToken } = req.body;
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken is required' });
    return;
  }

  try {
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!googleRes.ok) {
      res.status(401).json({ error: 'Invalid Google access token' });
      return;
    }

    const profile = await googleRes.json() as {
      sub: string; email: string; name: string; picture?: string;
    };

    if (!profile.email) {
      res.status(400).json({ error: 'No email from Google profile' });
      return;
    }

    const user = await upsertGoogleUser({
      google_id:  profile.sub,
      email:      profile.email,
      name:       profile.name,
      avatar_url: profile.picture ?? null,
    });

    const token = signToken({ userId: user.id, email: user.email });
    setTokenCookie(res, token);

    res.json({
      user: { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url, created_at: user.created_at },
      token,
    });
  } catch (err) {
    console.error('Google token verification error:', err);
    res.status(500).json({ error: 'Failed to verify Google token' });
  }
});

// ── Google OAuth ───────────────────────────────────────────────────────────────

router.get(
  '/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

router.get('/google/callback', (req: Request, res: Response, next) => {
  // Use a custom callback so we can handle errors from the strategy (DB errors,
  // missing email, etc.) and redirect back to the client with a helpful message
  // instead of letting them bubble up to the global error handler which returns
  // a generic 500.
  passport.authenticate('google', { session: false }, (err: any, user: any, info: any) => {
    const failureRedirect = `${process.env.CLIENT_URL}/login?error=google`;

    if (err) {
      console.error('Google OAuth error:', err);
      // Redirect to client with a hint that something went wrong server-side
      return res.redirect(`${failureRedirect}&reason=server`);
    }

    if (!user) {
      // Authentication failed (no user) — forward to client sign-in with info
      const msg = info?.message ? `&message=${encodeURIComponent(info.message)}` : '';
      return res.redirect(`${failureRedirect}${msg}`);
    }

    try {
      const token = signToken({ userId: user.id, email: user.email });
      setTokenCookie(res, token);
      // Redirect to frontend with token in query for SPA to pick up
      return res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`);
    } catch (e) {
      console.error('Failed to sign token or set cookie after Google auth:', e);
      return res.redirect(`${failureRedirect}&reason=server`);
    }
  })(req, res, next);
});

// ── Google OAuth — Mobile (polling-based) ─────────────────────────────────────

// Simple HTML page shown in the browser after the OAuth callback completes.
// The app closes the browser via WebBrowser.dismissBrowser() once polling picks
// up the token — this page is only visible for ~1-2 seconds.
function AUTH_DONE_PAGE(title: string, message: string) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;
justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#333}
h2{margin-bottom:8px}p{color:#666}</style></head>
<body><h2>${title}</h2><p>${message}</p></body></html>`;
}

// Temporary in-memory store: sessionId → { token, error, expiresAt }
const mobilePending = new Map<string, { token?: string; error?: string; expiresAt: number }>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  mobilePending.forEach((v, k) => { if (now > v.expiresAt) mobilePending.delete(k); });
}, 5 * 60 * 1000);

router.get('/google/mobile', (req: Request, res: Response, next) => {
  if (!process.env.GOOGLE_MOBILE_CALLBACK_URL) {
    res.status(503).json({ error: 'Mobile OAuth not configured on this server' });
    return;
  }
  const session = (req.query.session as string) || '';
  passport.authenticate('google-mobile', { scope: ['profile', 'email'], session: false, state: session } as any)(req, res, next);
});

router.get('/google/mobile/callback', (req: Request, res: Response, next) => {
  if (!process.env.GOOGLE_MOBILE_CALLBACK_URL) {
    res.status(503).json({ error: 'Mobile OAuth not configured on this server' });
    return;
  }

  passport.authenticate('google-mobile', { session: false }, (err: any, user: any) => {
    const session = (req.query.state as string) || '';
    const TTL = Date.now() + 5 * 60 * 1000;

    if (err || !user) {
      console.error('Google mobile OAuth error:', err);
      if (session) mobilePending.set(session, { error: 'auth_failed', expiresAt: TTL });
      return res.send(AUTH_DONE_PAGE('Sign-in failed', 'Could not sign in with Google. Please try again.'));
    }

    try {
      const token = signToken({ userId: user.id, email: user.email });
      if (session) mobilePending.set(session, { token, expiresAt: TTL });
      return res.send(AUTH_DONE_PAGE('Sign-in complete', 'You can close this window.'));
    } catch (e) {
      console.error('Failed to sign token:', e);
      if (session) mobilePending.set(session, { error: 'server_error', expiresAt: TTL });
      return res.send(AUTH_DONE_PAGE('Sign-in failed', 'Something went wrong. Please try again.'));
    }
  })(req, res, next);
});

// App polls this endpoint while the browser is open
router.get('/google/mobile/poll/:session', (req: Request, res: Response) => {
  const { session } = req.params;
  const pending = mobilePending.get(session);

  if (!pending || Date.now() > pending.expiresAt) {
    res.json({ ready: false });
    return;
  }

  mobilePending.delete(session);

  if (pending.error) {
    res.json({ ready: true, error: pending.error });
    return;
  }

  res.json({ ready: true, token: pending.token });
});

export default router;
