export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_id: string | null;
  password_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JwtPayload {
  userId: string;
  email: string;
}

export interface UserIdentity {
  user_id: string;
  domain: string;
  total_xp: number;
  level_index: number;
  level_name: string;
  updated_at: Date;
}

export interface DailyScore {
  id: number;
  user_id: string;
  date: string;
  score: number;
  xp_earned: number;
  created_at: Date;
}

export interface FullDailyScore extends DailyScore {
  discipline_score:    number | null;
  strength_score:      number | null;
  food_score:          number | null;
  final_score:         number | null;
  composite_xp_earned: number | null;
}

export interface SubmitFullDayInput {
  date: string;
  discipline: {
    buildCompleted:   number;
    buildTotal:       number;
    controlResisted:  number;
    controlTotal:     number;
  };
  strength: {
    consistency: number;
    effort:      number;
  };
  food: {
    calorieAccuracy:   number;
    proteinScore:      number;
    consistencyScore:  number;
  };
  streak: number;
}

export interface SubmitFullDayResult {
  disciplineScore: number;
  strengthScore:   number;
  foodScore:       number;
  finalScore:      number;
  xpEarned:        number;
  totalXP:         number;
  levelIndex:      number;
  levelName:       string;
  levelChanged:    boolean;
}

export interface SubmitDayInput {
  date: string;
  completedWeight: number;
  totalWeight: number;
  streak: number;
}

export interface SubmitDayResult {
  score: number;
  xpEarned: number;
  totalXP: number;
  levelIndex: number;
  levelName: string;
  levelChanged: boolean;
}

// Extend express-session with our user data
declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

// Extend passport user
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      avatar_url: string | null;
    }
  }
}
