import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, notReady, unauthorized } from '../../core/errors.js';
import { guardedCookieCount, guardedHeaderValues, loadBrowserContext, lockBrowserContext } from './browserIntents.js';
import { createSession, findUsableRefreshSession, REFRESH_COOKIE, setRefreshCookie, signSession } from './service.js';

export const GOOGLE_HANDOFF_COOKIE = '__Secure-outpost_google_handoff';
export const GOOGLE_HANDOFF_PATH = '/api/v1/auth/refresh';
export const GOOGLE_HANDOFF_TTL_SECONDS = 120;

export const GOOGLE_HANDOFF_COOKIE_OPTIONS = Object.freeze({
  path: GOOGLE_HANDOFF_PATH,
  secure: true,
  httpOnly: true,
  sameSite: 'strict',
});

export const GOOGLE_ATTEMPT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const GOOGLE_UUID_LUA = '^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89aAbB]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$';
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const keyFor = (proof) => `outpost:google-handoff:v1:${digest(proof)}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Compare, validate and consume the grant in one operation. No record fields are returned
// unless the cookie digest, attempt selector and complete identity projection are valid.
const consumeHandoff = `
  local raw = redis.pcall('GET', KEYS[1])
  if type(raw) ~= 'string' then return nil end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' or record.attemptId ~= ARGV[1]
     or record.contextId ~= ARGV[2] or record.generation ~= ARGV[3]
     or type(record.intentId) ~= 'string' or not string.match(record.intentId, '${GOOGLE_UUID_LUA}')
     or type(record.expiresAt) ~= 'number' or record.expiresAt <= tonumber(ARGV[4]) then return nil end
  local principal = record.principal
  if type(principal) ~= 'table' or type(principal.subject) ~= 'string' or
     #principal.subject < 1 or #principal.subject > 765 or
     type(principal.email) ~= 'string' or #principal.email > 960 or
     not string.match(principal.email, '^[^%s@]+@[^%s@]+%.[^%s@]+$') or
     (principal.name ~= cjson.null and (type(principal.name) ~= 'string' or #principal.name > 600)) then
    return nil
  end
  if ARGV[5] == 'consume' then redis.call('DEL', KEYS[1]) end
  return cjson.encode(record)
`;

function isPrincipal(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 255 &&
    typeof value.email === 'string' && value.email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
    (value.name === null || (typeof value.name === 'string' && value.name.length <= 200));
}

export async function createGoogleHandoff(redisClient, principal, intent, response) {
  const ttl = Math.min(GOOGLE_HANDOFF_TTL_SECONDS, Math.floor((intent.redeemUntil.getTime() - Date.now()) / 1000));
  if (ttl < 1) throw unauthorized('Invalid Google authentication handoff');
  if (!redisClient || !isPrincipal(principal)) {
    throw notReady('Google authentication is unavailable');
  }
  for (let index = 0; index < 3; index += 1) {
    const proof = randomBytes(32).toString('base64url');
    const record = JSON.stringify({
      attemptId: intent.actionId, contextId: intent.contextId, intentId: intent.id,
      generation: intent.generation.toString(), expiresAt: Date.now() + ttl * 1000, principal,
    });
    let stored;
    try {
      stored = await redisClient.set(keyFor(proof), record, {
        EX: ttl,
        NX: true,
      });
    } catch {
      throw notReady('Google authentication is unavailable');
    }
    if (stored) {
      response.cookie(GOOGLE_HANDOFF_COOKIE, proof, {
        ...GOOGLE_HANDOFF_COOKIE_OPTIONS,
        maxAge: GOOGLE_HANDOFF_TTL_SECONDS * 1000,
      });
      return;
    }
  }
  throw notReady('Google authentication is unavailable');
}

async function readGoogleHandoff(redisClient, proof, attemptId, context, mode) {
  let result;
  try {
    result = await redisClient.eval(consumeHandoff, {
      keys: [keyFor(proof)],
      arguments: [attemptId, context.id, context.generation.toString(), String(Date.now()), mode],
    });
  } catch {
    throw notReady('Google authentication is unavailable');
  }
  if (typeof result !== 'string') return null;
  try {
    const record = JSON.parse(result);
    if (record?.attemptId !== attemptId || record.contextId !== context.id ||
        record.generation !== context.generation.toString() || !GOOGLE_ATTEMPT_PATTERN.test(record.intentId) ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now() || !isPrincipal(record.principal)) return null;
    return record;
  } catch {
    return null;
  }
}

export async function currentGoogleIntent(prisma, { intentId, contextId, attemptId, generation }) {
  const intent = await prisma.authBrowserIntent.findUnique({ where: { id: intentId }, include: { context: true } });
  const now = new Date();
  if (!intent || intent.contextId !== contextId || intent.actionId !== attemptId || intent.kind !== 'google' ||
      !intent.claimedAt || intent.activatedAt || intent.redeemUntil <= now || intent.context.retiredAt ||
      intent.context.expiresAt <= now || intent.context.generation !== intent.generation ||
      intent.generation.toString() !== generation) return null;
  return intent;
}

export async function activateGoogleHandoff({ prisma, settings, redisClient, request, response }) {
  response.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
  });
  if (settings.googleHandoffEnabled !== true || !settings.publicAppOrigin) {
    throw notReady('Google authentication is not configured');
  }

  const origins = guardedHeaderValues(request, 'origin');
  const attempts = guardedHeaderValues(request, 'x-acadboost-google-attempt');
  const attemptId = attempts[0]?.toLowerCase();
  if (attempts.length !== 1 || !GOOGLE_ATTEMPT_PATTERN.test(attemptId ?? '') ||
      origins.length !== 1 || origins[0] !== settings.publicAppOrigin ||
      guardedCookieCount(request, GOOGLE_HANDOFF_COOKIE) !== 1 || guardedCookieCount(request, REFRESH_COOKIE) > 1) {
    throw unauthorized('Invalid Google authentication handoff');
  }
  const hasBody = request.body !== undefined ||
    (Number(request.get('Content-Length') || 0) > 0) || Boolean(request.get('Transfer-Encoding'));
  if (hasBody) throw unauthorized('Invalid Google authentication handoff');
  if (!redisClient) throw notReady('Google authentication is unavailable');

  const proof = request.cookies?.[GOOGLE_HANDOFF_COOKIE];
  if (!PROOF_PATTERN.test(proof ?? '')) throw unauthorized('Invalid Google authentication handoff');

  const context = await loadBrowserContext(prisma, request, settings);
  const pending = await readGoogleHandoff(redisClient, proof, attemptId, context, 'peek');
  if (!pending || !await currentGoogleIntent(prisma, pending)) throw unauthorized('Invalid Google authentication handoff');
  if (await findUsableRefreshSession(prisma, request.cookies?.[REFRESH_COOKIE], settings, request)) {
    throw new AppError(409, 'session_conflict', 'A signed-in session already exists.');
  }

  const grant = await readGoogleHandoff(redisClient, proof, attemptId, context, 'consume');
  if (!grant) throw unauthorized('Invalid Google authentication handoff');
  response.clearCookie(GOOGLE_HANDOFF_COOKIE, GOOGLE_HANDOFF_COOKIE_OPTIONS);

  const issued = await prisma.$transaction(async (tx) => {
    const locked = await lockBrowserContext(tx, request, settings);
    if (locked.id !== grant.contextId || locked.generation.toString() !== grant.generation) {
      throw unauthorized('Invalid Google authentication handoff');
    }
    const intent = await currentGoogleIntent(tx, grant);
    if (!intent) throw unauthorized('Invalid Google authentication handoff');
    const user = await resolveGoogleUser(tx, grant.principal);
    const [{ now }] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
    if (now >= intent.redeemUntil || now >= locked.expiresAt || now.getTime() >= grant.expiresAt) {
      throw unauthorized('Invalid Google authentication handoff');
    }
    const tokenFamilyId = randomUUID();
    await tx.authBrowserIntent.update({
      where: { id: intent.id },
      data: { tokenFamilyId, sessionUserId: user.id, activatedAt: new Date(Math.max(now, intent.claimedAt)) },
    });
    return createSession(tx, settings, user, 'google_oidc', request, {
      intentId: intent.id, tokenFamilyId, expiresAt: locked.expiresAt,
    });
  });
  const credentials = await signSession(settings, issued);
  setRefreshCookie(response, credentials.refresh, credentials.expiresAt);
  response.set('Pragma', 'no-cache');
  response.json({ access_token: credentials.access, token_type: 'bearer', expires_in: 900 });
}

async function resolveGoogleUser(tx, principal) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(7301, hashtext(${principal.subject}))`;
  const identity = await tx.oAuthIdentity.findUnique({
    where: { provider_providerSubject: { provider: 'google', providerSubject: principal.subject } },
  });
  if (identity) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${identity.userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: identity.userId } });
    if (!user || user.status !== 'active') throw unauthorized('Invalid Google authentication response');
    await tx.oAuthIdentity.update({ where: { id: identity.id }, data: { providerEmail: principal.email } });
    return user;
  }
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(7302, hashtext(${principal.email}))`;
  const owner = await tx.user.findFirst({
    where: { primaryEmail: { equals: principal.email, mode: 'insensitive' } },
  });
  const user = await tx.user.create({
    data: {
      displayName: principal.name || 'Outpost member',
      primaryEmail: owner ? null : principal.email,
      emailVerifiedAt: owner ? null : new Date(),
    },
  });
  await tx.oAuthIdentity.create({
    data: {
      userId: user.id,
      provider: 'google',
      providerSubject: principal.subject,
      providerEmail: principal.email,
    },
  });
  return user;
}
