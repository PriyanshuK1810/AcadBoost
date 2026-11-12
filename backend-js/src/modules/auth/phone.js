import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { AppError, notReady, unauthorized } from '../../core/errors.js';
import { lockUserRows } from './browserIntents.js';
import { acceptCredentialIntent, checkCredentialDeadline, lockCredentialIntent } from './routes.js';
import { createSession, setRefreshCookie, signSession } from './service.js';

const INVALID = 'Invalid or expired OTP';
const RATE_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;
const otpInput = z.strictObject({ phone: z.string() });
const verifyInput = otpInput.extend({ code: z.string().regex(/^[0-9]{6}$/) });

export function normalizePhone(value) {
  const number = parsePhoneNumberFromString(value.trim());
  if (!number?.isValid()) throw new Error('Phone number must be a valid international phone number');
  return number.number;
}

export function otpDigest(settings, phone, code) {
  if (!settings.otpHmacKey) throw notReady('Authentication is not configured');
  const payload = Buffer.concat([
    Buffer.from('outpost:otp:v1'), Buffer.from([0]), Buffer.from(phone),
    Buffer.from([0]), Buffer.from('login'), Buffer.from([0]), Buffer.from(code),
  ]);
  return 'hmac-sha256:v1:' + createHmac('sha256', settings.otpHmacKey).update(payload).digest('hex');
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(422, 'validation_error', 'Request validation failed',
      result.error.issues.map((issue) => ({ loc: ['body', ...issue.path], type: issue.code })));
  }
  try {
    return { ...result.data, phone: normalizePhone(result.data.phone) };
  } catch {
    throw new AppError(422, 'validation_error', 'Request validation failed',
      [{ loc: ['body', 'phone'], type: 'value_error' }]);
  }
}

function limiterKey(settings, scope, identifier) {
  if (!settings.otpHmacKey) throw notReady('Authentication is not configured');
  const payload = Buffer.concat([
    Buffer.from('outpost:otp-request:v1'), Buffer.from([0]), Buffer.from(scope),
    Buffer.from([0]), Buffer.from(identifier),
  ]);
  const hash = createHmac('sha256', settings.otpHmacKey).update(payload).digest('hex');
  return `outpost:otp-request:v1:${scope}:${hash}`;
}

async function checkRate(redisClient, settings, phone, request) {
  if (!redisClient) throw notReady('Rate limiting is unavailable');
  try {
    const ip = request.socket.remoteAddress || 'unknown';
    const phoneCount = Number(await redisClient.eval(RATE_SCRIPT, {
      keys: [limiterKey(settings, 'phone', phone)], arguments: ['900'],
    }));
    const ipCount = Number(await redisClient.eval(RATE_SCRIPT, {
      keys: [limiterKey(settings, 'ip', ip)], arguments: ['900'],
    }));
    if (phoneCount > 5 || ipCount > 20) {
      throw new AppError(429, 'rate_limited', 'Too many OTP requests');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw notReady('Rate limiting is unavailable');
  }
}

export class DevelopmentSmsProvider {
  outbox = [];
  async send(message) { this.outbox.push(message); }
}

export function registerPhoneRoutes(app, {
  prisma, settings, redisClient,
  smsProvider = settings.smsProvider === 'development'
    ? new DevelopmentSmsProvider()
    : { send: async () => { throw Error('SMS disabled'); } },
}) {
  app.post('/api/v1/auth/phone/request', async (request, response) => {
    const { phone } = parse(otpInput, request.body);
    await checkRate(redisClient, settings, phone, request);
    let code;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${phone}, 0))`;
      const latest = await tx.otpChallenge.findFirst({
        where: { phoneE164: phone, purpose: 'login' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const now = new Date();
      if (latest && latest.resendAvailableAt > now) return;
      await tx.otpChallenge.updateMany({
        where: { phoneE164: phone, purpose: 'login', consumedAt: null },
        data: { consumedAt: now },
      });
      code = String(randomInt(1_000_000)).padStart(6, '0');
      await tx.otpChallenge.create({
        data: {
          id: randomUUID(), phoneE164: phone, purpose: 'login',
          otpDigest: otpDigest(settings, phone, code), attemptCount: 0,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 5 * 60_000),
          resendAvailableAt: new Date(now.getTime() + 60_000),
        },
      });
    });
    if (code) {
      try {
        await smsProvider.send({ to: phone, text: `Your Outpost login code is ${code}. It expires in 5 minutes.` });
      } catch {
        console.error('phone_otp.delivery_failed');
      }
    }
    response.set('Cache-Control', 'no-store').status(202).end();
  });

  app.post('/api/v1/auth/phone/verify', async (request, response) => {
    const { phone, code } = parse(verifyInput, request.body);
    const intent = await acceptCredentialIntent(prisma, settings, request, 'phone');
    if (!settings.authSigningKey) throw notReady('Authentication is not configured');
    const outcome = await prisma.$transaction(async (tx) => {
      await lockCredentialIntent(tx, settings, request, intent);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${phone}, 0))`;
      await checkCredentialDeadline(tx, intent);
      const challenge = await tx.otpChallenge.findFirst({
        where: { phoneE164: phone, purpose: 'login' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const now = new Date();
      if (!challenge || challenge.consumedAt || challenge.attemptCount >= 5 || challenge.expiresAt <= now) {
        return { rejected: true };
      }
      const expected = otpDigest(settings, phone, code);
      const lhs = Buffer.from(expected);
      const rhs = Buffer.from(challenge.otpDigest);
      if (lhs.length !== rhs.length || !timingSafeEqual(lhs, rhs)) {
        await tx.otpChallenge.update({
          where: { id: challenge.id }, data: { attemptCount: challenge.attemptCount + 1 },
        });
        return { rejected: true };
      }
      await tx.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
      let identity = await tx.phoneIdentity.findUnique({ where: { phoneE164: phone } });
      let user;
      if (identity) {
        if (intent) await lockUserRows(tx, [identity.userId]);
        await checkCredentialDeadline(tx, intent);
        user = await tx.user.findUnique({ where: { id: identity.userId } });
        if (!user || user.status !== 'active') return { rejected: true };
        if (!identity.verifiedAt) {
          identity = await tx.phoneIdentity.update({ where: { id: identity.id }, data: { verifiedAt: now } });
        }
      } else {
        user = await tx.user.create({ data: { displayName: 'Outpost member' } });
        identity = await tx.phoneIdentity.create({
          data: { id: randomUUID(), userId: user.id, phoneE164: phone, verifiedAt: now },
        });
      }
      const issued = await createSession(tx, settings, user, 'phone_otp', request);
      return { issued };
    });
    if (outcome.rejected) throw unauthorized(INVALID);
    const credentials = await signSession(settings, outcome.issued);
    setRefreshCookie(response, credentials.refresh);
    response.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    response.json({ access_token: credentials.access, token_type: 'bearer', expires_in: 900 });
  });
}
