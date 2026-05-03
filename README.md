# Habit Tracker — Backend

Express + TypeScript REST API. Handles authentication, task persistence, strength XP system, and nutrition tracking. PostgreSQL database.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js |
| Framework | Express 4 |
| Language | TypeScript |
| Database | PostgreSQL (node-postgres `pg`) |
| Auth | JWT (jsonwebtoken) + bcrypt |
| OAuth | Passport.js (Google OAuth 2.0) |
| Sessions | express-session (OAuth handshake only) |
| Validation | Zod |
| Dev server | ts-node / nodemon |

---

## Project Structure

```
src/
├── index.ts                   # Express app setup, middleware, route mounting
├── passport.ts                # Passport Google OAuth strategy
│
├── types/
│   └── index.ts               # TypeScript interfaces
│
├── middleware/
│   └── auth.ts                # requireAuth middleware, JWT sign/verify, cookie helper
│
├── db/
│   ├── pool.ts                # PostgreSQL connection pool
│   ├── users.ts               # User CRUD functions
│   ├── identity.ts            # Strength identity/XP DB operations
│   ├── migrate.ts             # Initial schema migration
│   ├── migrate-fuel.ts        # Nutrition tables migration
│   ├── migrate-strength.ts    # Strength XP + leaderboard tables migration
│   └── migrate-startdate.ts   # Adds start_date + category to tasks
│
├── routes/
│   ├── auth.ts                # Signup, login, logout, Google OAuth, /me
│   ├── tasks.ts               # Habit CRUD (list, create, update, delete)
│   ├── users.ts               # User profile routes
│   ├── strength.ts            # Submit day, get identity, leaderboard
│   └── fuel.ts                # Nutrition/calorie tracking routes
│
└── services/
    ├── strength.ts            # XP calculation + level system logic
    └── fuelService.ts         # Calorie/nutrition business logic
```

---

## Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/habitdb
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d
SESSION_SECRET=your-session-secret        # Required — process exits if missing
CLIENT_URL=http://localhost:5173          # Frontend URL for CORS + OAuth redirects
NODE_ENV=development                      # or "production"

# Google OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback
```

---

## Server Entry — `index.ts`

```
Middleware stack (in order):
  1. cors({ origin: CLIENT_URL, credentials: true })
  2. express.json()
  3. cookie-parser
  4. express-session({ secret: SESSION_SECRET, maxAge: 10 min })
     → Used only for OAuth handshake; JWT handles long-lived auth
  5. passport.initialize() + passport.session()

Routes mounted at /api:
  /api/auth      → auth.ts
  /api/users     → users.ts
  /api/tasks     → tasks.ts
  /api/strength  → strength.ts
  /api/fuel      → fuel.ts

Health check: GET /health → { status: 'ok' }

Global error handler: returns 500 { error: 'Internal server error' }
```

---

## Database — `db/pool.ts`

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### Helper functions

```typescript
query<T>(text: string, params?: any[]): Promise<T[]>
// Executes SQL, returns rows array typed as T[]

queryOne<T>(text: string, params?: any[]): Promise<T | null>
// Returns first row or null
```

---

## Database Schema

### Initial Migration — `migrate.ts`

```sql
-- Users
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  avatar_url   TEXT,
  google_id    TEXT UNIQUE,
  password_hash TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Express-session storage (OAuth only)
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habits / disciplines
CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,          -- lowercase, trimmed
  score           INTEGER DEFAULT 0,
  days            JSONB DEFAULT '[]',     -- e.g. ["Mon","Wed","Fri"]
  archived_at     TIMESTAMPTZ NULL,       -- NULL = active
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Completion audit trail
CREATE TABLE habit_completions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  task_id         UUID NULL,              -- NULL if task was deleted
  task_name       TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  date            DATE NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

**Indexes**
```sql
CREATE INDEX ON sessions(user_id);
CREATE INDEX ON users(google_id);
CREATE INDEX ON users(email);
CREATE INDEX ON tasks(user_id);
CREATE INDEX ON tasks(normalized_name);
CREATE INDEX ON habit_completions(normalized_name, date);
CREATE INDEX ON habit_completions(user_id, normalized_name, date);
```

---

### Migration: `migrate-startdate.ts`

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'build';
```

After adding columns, sets `start_date = '2026-04-05'` for all tasks belonging to a specific user (one-time data backfill).

---

### Migration: `migrate-strength.ts`

```sql
CREATE TABLE strength_identity (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL DEFAULT 'strength',
  total_xp    INTEGER NOT NULL DEFAULT 0,
  level_index INTEGER NOT NULL DEFAULT 0,
  level_name  TEXT NOT NULL DEFAULT 'Novice',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE strength_leaderboard (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  date       DATE NOT NULL,
  score      NUMERIC NOT NULL,
  xp_earned  INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### Migration: `migrate-fuel.ts`

Adds nutrition / calorie tracking tables (fuel log, daily targets).

---

## Authentication — `middleware/auth.ts`

### `requireAuth` middleware

```
1. Read token from:
   a. Cookie "token"
   b. Header "Authorization: Bearer {token}"
2. Verify with JWT_SECRET (jsonwebtoken.verify)
3. On success: attach req.userId and req.userEmail
4. On failure: return 401 { error: 'Unauthorized' }
```

### `signToken(payload: JwtPayload): string`

```
jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN || '7d' })
```

### `setTokenCookie(res, token)`

```
res.cookie('token', token, {
  httpOnly: true,
  secure: NODE_ENV === 'production',
  sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
})
```

---

## Routes

### Auth — `routes/auth.ts`

#### `POST /api/auth/signup`

**Input validation (Zod)**
```
name: string (min 1)
email: string (valid email format)
password: string (min 8 characters)
```

**Flow**
```
1. Validate input with Zod
2. Check for existing user with same email → 409 if duplicate
3. bcrypt.hash(password, 12)
4. INSERT into users
5. signToken({ userId, email })
6. setTokenCookie(res, token)
7. Return 201 { user: { id, email, name }, token }
```

---

#### `POST /api/auth/login`

**Flow**
```
1. Find user by email
2. If not found or no password_hash → 401
3. bcrypt.compare(password, hash)
4. If mismatch → 401
5. signToken + setTokenCookie
6. Return 200 { user, token }
```

---

#### `POST /api/auth/logout`

```
res.clearCookie('token')
Return 200 { message: 'Logged out' }
```

---

#### `GET /api/auth/me`  *(requireAuth)*

```
SELECT id, email, name, avatar_url FROM users WHERE id = req.userId
Return 200 { user }
```

---

#### `GET /api/auth/google`

Passport redirect to Google OAuth consent screen. Scopes: `profile`, `email`.

#### `GET /api/auth/google/callback`

```
1. Passport exchanges code for tokens, finds/creates user
2. signToken({ userId, email })
3. Redirect to {CLIENT_URL}/auth/callback?token={token}
   OR on error: {CLIENT_URL}/auth/error?error={message}
```

---

### Tasks — `routes/tasks.ts`

All routes protected by `requireAuth`.

#### `GET /api/tasks`

```sql
SELECT id, user_id, name, normalized_name, score, days,
       archived_at, start_date, category, created_at, updated_at
FROM tasks
WHERE user_id = $1
ORDER BY created_at DESC
```

Returns `200 Task[]`

---

#### `POST /api/tasks`

**Body**: `{ name, score, days, category?, startDate? }`

```
1. Validate: name required, score integer
2. normalized_name = name.toLowerCase().trim()
3. INSERT into tasks (user_id, name, normalized_name, score, days, category, start_date)
4. Return 201 created_task
```

---

#### `PUT /api/tasks/:id`

**Body**: any subset of `{ name, score, days, archived, category, startDate }`

```
1. Build SET clause dynamically from provided fields
2. Maps: startDate → start_date, archived: true → archived_at = NOW(),
                                  archived: false → archived_at = NULL
3. Always sets updated_at = NOW()
4. WHERE id = $n AND user_id = $m  (ownership check)
5. Return 200 updated_task
```

---

#### `DELETE /api/tasks/:id`

```sql
DELETE FROM tasks WHERE id = $1 AND user_id = $2
```

Returns `200 { message: 'Deleted' }` or `404` if not found / wrong owner.

---

### Strength — `routes/strength.ts`

All routes protected by `requireAuth`.

#### `POST /api/strength/submit-day`

**Body**
```
date: string (YYYY-MM-DD)
completedWeight: number (≥ 0)
totalWeight: number (≥ 0)
streak: integer (≥ 0)
```

**Validation**: `completedWeight <= totalWeight`

**Flow**
```
1. Validate input
2. Call submitDay(userId, { date, completedWeight, totalWeight, streak })
3. submitDay() in services/strength.ts:
   a. Calculates score = (completedWeight / totalWeight) * 100
   b. Calculates xpEarned based on score + streak bonus
   c. Upserts strength_identity (increment total_xp, update level)
   d. Inserts into strength_leaderboard
   e. Returns { score, xpEarned, totalXP, levelIndex, levelName, levelChanged }
4. Return 200 result
```

---

#### `GET /api/strength/identity`

```
1. Query strength_identity WHERE user_id = req.userId
2. If no row exists: return zero-state { totalXP: 0, levelIndex: 0, ... }
3. Return 200 identity
```

---

### Users — `routes/users.ts`

Profile read/update endpoints. Protected by `requireAuth`.

---

### Fuel — `routes/fuel.ts`

Nutrition log CRUD. Schema added via `migrate-fuel.ts`.

---

## Services

### `services/strength.ts`

**Level system**: Array of level names (Novice → Elite → Legend → …). `levelIndex` is the index into this array.

**`submitDay(userId, input)`**
```
score      = (completedWeight / totalWeight) * 100
baseXP     = Math.round(score * 1.5)         // 0–150 XP per day
streakBonus = streak * 5                      // +5 XP per streak day
xpEarned   = baseXP + streakBonus

1. UPSERT strength_identity: total_xp += xpEarned, recalculate levelIndex
2. INSERT strength_leaderboard row
3. Return { score, xpEarned, totalXP, levelIndex, levelName, levelChanged }
```

**`getIdentity(userId)`**
```
SELECT total_xp, level_index, level_name FROM strength_identity WHERE user_id = $1
If not found: return zero-state
```

---

## TypeScript Interfaces — `types/index.ts`

```typescript
interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_id: string | null;
  password_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

interface JwtPayload {
  userId: string;
  email: string;
}

interface UserIdentity {
  user_id: string;
  domain: string;
  total_xp: number;
  level_index: number;
  level_name: string;
  updated_at: Date;
}

interface SubmitDayInput {
  date: string;
  completedWeight: number;
  totalWeight: number;
  streak: number;
}

interface SubmitDayResult {
  score: number;
  xpEarned: number;
  totalXP: number;
  levelIndex: number;
  levelName: string;
  levelChanged: boolean;
}
```

---

## Data Flow Summary

```
Client (React)                          Server (Express)
─────────────────────────────────────────────────────────
1. Signup/Login
   POST /api/auth/signup  ──────────►  Hash password, create user
                          ◄──────────  { user, token }
   Store token in localStorage

2. Load habits on app start
   GET /api/tasks (Bearer) ─────────►  SELECT tasks WHERE user_id
                           ◄─────────  Task[] (with start_date, category)
   Merge with local IndexedDB
   Display in UI

3. Create new habit
   Optimistic add to local state
   POST /api/tasks  ────────────────►  INSERT task
                    ◄────────────────  Created task (canonical UUID)
   Replace temp id with server UUID

4. Toggle habit completion
   Update local IndexedDB (logs store)
   ← no server call; completions are client-side only →

5. Archive habit
   Update local state immediately
   PUT /api/tasks/:id { archived: true } ──►  SET archived_at = NOW()

6. Workout day XP
   POST /api/strength/submit-day  ───►  Calculate XP, upsert identity
                                  ◄───  { xpEarned, levelName, levelChanged }
```

---

## Security Notes

- Passwords hashed with **bcrypt, 12 rounds**
- JWT tokens expire after **7 days**
- All task mutations validate `user_id = req.userId` (row-level ownership)
- Cookies set `httpOnly: true` — not accessible from JavaScript
- `secure: true` and `sameSite: 'none'` in production for cross-origin cookie support
- Sessions last only **10 minutes** (OAuth handshake window only)
- `SESSION_SECRET` is required — server exits at startup if not provided

---

## Getting Started

```bash
cd server-habit-tracker
npm install

# Set up .env (copy from above)
cp .env.example .env

# Run initial DB migrations
npx ts-node src/db/migrate.ts
npx ts-node src/db/migrate-strength.ts
npx ts-node src/db/migrate-fuel.ts
npx ts-node src/db/migrate-startdate.ts

# Start dev server
npm run dev        # runs on http://localhost:3001
```

### Common SQL Checks

```sql
-- List all users
SELECT id, email, name, created_at FROM users;

-- List tasks for a user
SELECT name, category, start_date, archived_at
FROM tasks WHERE user_id = '...' ORDER BY created_at;

-- Fix wrong category for a user
UPDATE tasks
SET category = 'control'
WHERE user_id = (SELECT id FROM users WHERE email = 'user@example.com')
  AND name ILIKE ANY (ARRAY['%smoking%', '%alcohol%']);

-- Check strength identity
SELECT u.email, s.total_xp, s.level_name
FROM strength_identity s JOIN users u ON s.user_id = u.id;
```
# Grittt-server
