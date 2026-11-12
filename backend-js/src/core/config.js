import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) loadEnvFile(envFile);

const schema = z.object({
  OUTPOST_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  OUTPOST_DATABASE_URL: z.string().min(1),
  OUTPOST_AUTH_SIGNING_KEY: z.string().min(32).optional(),
  OUTPOST_VALKEY_URL: z.string().default('redis://127.0.0.1:6379/0'),
  OUTPOST_EMAIL_PROVIDER: z.enum(['disabled', 'development', 'smtp']).default('disabled'),
  OUTPOST_SMS_PROVIDER: z.enum(['disabled', 'development']).default('disabled'),
  OUTPOST_GOOGLE_HANDOFF_ENABLED: z.enum(['true', 'false']).default('false'),
});

function validateGoogleHandoff(settings) {
  const origin = URL.parse(settings.publicAppOrigin ?? '');
  if (origin?.protocol !== 'https:' || origin.origin !== settings.publicAppOrigin ||
      settings.googleRedirectUri !== `${origin.origin}/api/v1/auth/google/callback`) {
    throw new Error('Google handoff requires a canonical HTTPS application origin and its exact callback URI');
  }
  if (!settings.googleClientId?.trim() || !settings.googleClientSecret?.trim() || !settings.authSigningKey) {
    throw new Error('Google handoff requires Google client credentials and an auth signing key');
  }
}

export function loadSettings(environment = process.env) {
  const parsed = schema.parse(environment);
  const databaseUrl = parsed.OUTPOST_DATABASE_URL.replace(/^postgresql\+psycopg:\/\//, 'postgresql://');
  const settings = {
    env: parsed.OUTPOST_ENV,
    databaseUrl,
    authSigningKey: parsed.OUTPOST_AUTH_SIGNING_KEY,
    valkeyUrl: parsed.OUTPOST_VALKEY_URL,
    emailProvider: parsed.OUTPOST_EMAIL_PROVIDER,
    smsProvider: parsed.OUTPOST_SMS_PROVIDER,
    otpHmacKey: environment.OUTPOST_OTP_HMAC_KEY,
    googleClientId: environment.OUTPOST_GOOGLE_CLIENT_ID,
    googleClientSecret: environment.OUTPOST_GOOGLE_CLIENT_SECRET,
    googleRedirectUri: environment.OUTPOST_GOOGLE_REDIRECT_URI,
    googleHandoffEnabled: parsed.OUTPOST_GOOGLE_HANDOFF_ENABLED === 'true',
    publicAppOrigin: environment.OUTPOST_PUBLIC_APP_ORIGIN,
    emailFromAddress: environment.OUTPOST_EMAIL_FROM_ADDRESS || 'no-reply@outpost.example',
    emailVerificationUrl: environment.OUTPOST_EMAIL_VERIFICATION_URL || 'http://localhost:5173/verify-email',
    passwordResetUrl: environment.OUTPOST_PASSWORD_RESET_URL || 'http://localhost:5173/reset-password',
    emailSmtpHost: environment.OUTPOST_EMAIL_SMTP_HOST || '127.0.0.1',
    emailSmtpPort: Number(environment.OUTPOST_EMAIL_SMTP_PORT || 1025),
    emailSmtpStarttls: environment.OUTPOST_EMAIL_SMTP_STARTTLS === 'true',
    emailSmtpUsername: environment.OUTPOST_EMAIL_SMTP_USERNAME,
    emailSmtpPassword: environment.OUTPOST_EMAIL_SMTP_PASSWORD,
    objectStorage: environment.OUTPOST_OBJECT_ACCESS_KEY && environment.OUTPOST_OBJECT_SECRET_KEY
      ? {
        endpoint: environment.OUTPOST_OBJECT_ENDPOINT || 'http://127.0.0.1:9000',
        bucket: environment.OUTPOST_OBJECT_BUCKET || 'outpost-activity-plans',
        accessKey: environment.OUTPOST_OBJECT_ACCESS_KEY,
        secretKey: environment.OUTPOST_OBJECT_SECRET_KEY,
      }
      : null,
  };
  if (settings.googleHandoffEnabled) validateGoogleHandoff(settings);
  if (Boolean(environment.OUTPOST_OBJECT_ACCESS_KEY) !== Boolean(environment.OUTPOST_OBJECT_SECRET_KEY)) {
    throw new Error('Both object storage credentials are required');
  }
  if (settings.env !== 'development' && settings.env !== 'test') {
    if (settings.smsProvider === 'development' || settings.emailProvider === 'development') {
      throw new Error('Development outbound providers cannot run outside development/test');
    }
  }
  return settings;
}
