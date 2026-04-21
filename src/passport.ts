import passport from 'passport';
import { Strategy as GoogleStrategy, Profile, VerifyCallback } from 'passport-google-oauth20';
import { upsertGoogleUser } from './db/users';

async function verifyGoogleProfile(
  _accessToken: string,
  _refreshToken: string,
  profile: Profile,
  done: VerifyCallback
): Promise<void> {
  try {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error('No email from Google profile'));

    const user = await upsertGoogleUser({
      google_id:  profile.id,
      email,
      name:       profile.displayName,
      avatar_url: profile.photos?.[0]?.value ?? null,
    });

    done(null, { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url });
  } catch (err) {
    done(err as Error);
  }
}

export function setupPassport(): void {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    throw new Error([
      'Google OAuth is not configured. Please set the following environment variables:',
      '  - GOOGLE_CLIENT_ID',
      '  - GOOGLE_CLIENT_SECRET',
      '  - GOOGLE_CALLBACK_URL',
      "You can add them to your .env file (used by dotenv) or your environment."
    ].join('\n'));
  }

  // Web OAuth strategy
  passport.use(
    'google',
    new GoogleStrategy(
      { clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: GOOGLE_CALLBACK_URL },
      verifyGoogleProfile
    )
  );

  // Mobile OAuth strategy — only registered when the env var is set
  const { GOOGLE_MOBILE_CALLBACK_URL } = process.env;
  if (GOOGLE_MOBILE_CALLBACK_URL) {
    passport.use(
      'google-mobile',
      new GoogleStrategy(
        { clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: GOOGLE_MOBILE_CALLBACK_URL },
        verifyGoogleProfile
      )
    );
  }

  // Not using sessions for JWT-based auth, but passport needs these stubs
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user as Express.User));
}
