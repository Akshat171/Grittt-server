import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import passport from 'passport';

import { setupPassport } from './passport';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import tasksRoutes from './routes/tasks';
import habitsRoutes from './routes/habits';
import strengthRoutes from './routes/strength';
import fuelRoutes from './routes/fuel';
import scoreRoutes from './routes/score';
import aiRoutes from './routes/ai';

const app = express();
const PORT = process.env.PORT ?? 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ── Static assets (3D models, etc.) ───────────────────────────────────────────
app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

// Session only needed for the OAuth handshake redirect flow
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error('FATAL: SESSION_SECRET is not set. Please set SESSION_SECRET in your environment or .env');
  process.exit(1);
}

app.use(session({
  // Provide an explicit secret string to avoid express-session falling back to
  // req.secret (which causes the deprecated warning seen during startup).
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 10 * 60 * 1000, // 10 min — just for OAuth flow
  },
}));

// ── Passport ───────────────────────────────────────────────────────────────────

setupPassport();
app.use(passport.initialize());
app.use(passport.session());

// ── Routes ─────────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/habits', habitsRoutes);
app.use('/api/strength', strengthRoutes);
app.use('/api/fuel', fuelRoutes);
app.use('/api/score', scoreRoutes);
app.use('/api/ai', aiRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Error handler ──────────────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV ?? 'development'}`);
});

export default app;
