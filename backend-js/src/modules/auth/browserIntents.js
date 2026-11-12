import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../core/errors.js';

export const BROWSER_CONTEXT_COOKIE = '__Host-outpost_auth_context';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_RATE_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(['google', 'password', 'phone', 'logout', 'logout_all']);
const headerValues = (request, name) => {
  const raw = request?.rawHeaders;
  if (Array.isArray(raw)) {
    const values = [];
    for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === name.toLowerCase()) values.push(raw[i + 1]);
    if (values.length) return values;
  }
  const value = request?.headers?.[name.toLowerCase()];
  return value === undefined ? [] : [value];
};
function cookieValues(request) {
  const values = [];
  for (const part of String(request?.headers?.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at >= 0 && part.slice(0, at).trim() === BROWSER_CONTEXT_COOKIE) values.push(part.slice(at + 1).trim());
  }
  return values;
}
export function guardedCookieCount(request, name) {
  return String(request?.headers?.cookie ?? '').split(';').filter(part => {
    const at = part.indexOf('=');
    return at >= 0 && part.slice(0, at).trim() === name;
  }).length;
}
export function guardedHeaderValues(request, name) { return headerValues(request, name); }
function proof(request) {
  const values = cookieValues(request);
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0])) return null;
  const decoded = Buffer.from(values[0], 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== values[0]) return null;
  return decoded;
}
export function contextProofDigest(request) {
  try { const value = proof(request); return value ? createHash('sha256').update(value).digest() : null; }
  catch { return null; }
}
export function hasBrowserContext(request) { try { return cookieValues(request).length > 0; } catch { return false; } }
export function validateBrowserRequest(request, settings, headerName) {
  const origins = headerValues(request, 'origin');
  const markers = headerValues(request, headerName);
  const cookies = cookieValues(request);
  const contentTypes = headerValues(request, 'content-type');
  return origins.length === 1 && origins[0] === settings?.publicAppOrigin &&
    markers.length === 1 && markers[0] === '1' && cookies.length <= 1 &&
    contentTypes.length === 1 && String(contentTypes[0]).split(';')[0].trim().toLowerCase() === 'application/json' &&
    (!request.headers?.['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin');
}
export function browserActionId(request, settings) {
  const origins = headerValues(request, 'origin');
  if (origins.length !== 1 || origins[0] !== settings?.publicAppOrigin) {
    throw new AppError(403, 'origin_not_allowed', 'Request origin is not allowed');
  }
  if (!contextProofDigest(request)) throw unauthorized();
  const values = headerValues(request, 'x-acadboost-auth-intent');
  if (values.length !== 1 || !UUID_V4.test(values[0])) {
    throw new AppError(422, 'invalid_auth_intent', 'A valid authentication intent identifier is required');
  }
  return values[0].toLowerCase();
}
function unauthorized() { return new AppError(401, 'unauthorized', 'Invalid or expired browser authentication context'); }
async function eligibleContext(prisma, digest) {
  if (!digest) throw unauthorized();
  const rows = await prisma.$queryRaw`SELECT id, binding_digest AS "bindingDigest", generation,
    created_at AS "createdAt", expires_at AS "expiresAt", retired_at AS "retiredAt"
    FROM auth_browser_contexts WHERE binding_digest = ${digest} AND retired_at IS NULL
      AND expires_at > clock_timestamp()`;
  const context = rows[0];
  if (!context) throw unauthorized();
  return context;
}
export async function loadBrowserContext(prisma, request, settings) {
  void settings;
  return eligibleContext(prisma, contextProofDigest(request));
}
export async function lockBrowserContext(tx, request, settings) {
  void settings;
  const digest = contextProofDigest(request);
  if (!digest) throw unauthorized();
  const rows = await tx.$queryRaw`SELECT id FROM auth_browser_contexts WHERE binding_digest = ${digest} FOR UPDATE`;
  if (!rows.length) throw unauthorized();
  return eligibleContext(tx, digest);
}
export async function lockUserRows(tx, userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))].sort();
  if (!ids.length) return [];
  return tx.$queryRaw`SELECT id FROM users WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
}
export async function findCurrentGoogleReceipt(tx, context) {
  return tx.authBrowserIntent.findFirst({ where: { contextId: context.id, kind: 'google', generation: context.generation, activatedAt: { not: null }, supersededAt: null } });
}
export async function findBrowserAction(tx, context, actionId) {
  return tx.authBrowserIntent.findUnique({ where: { contextId_actionId: { contextId: context.id, actionId } } });
}
export async function advanceBrowserIntent(tx, context, { actionId, kind, logoutOutcome = null }) {
  if (!UUID_V4.test(actionId ?? '') || !KINDS.has(kind)) throw new AppError(400, 'invalid_auth_intent', 'Invalid authentication intent');
  const existing = await findBrowserAction(tx, context, actionId);
  if (existing) return { duplicate: true, intent: existing };
  const currentReceipt = await findCurrentGoogleReceipt(tx, context);
  // The caller holds the browser-context lock and locks every affected user
  // (including this receipt owner) in sorted UUID order before this helper.
  const [reread] = await tx.$queryRaw`WITH decision_clock AS (SELECT clock_timestamp() AS now)
    SELECT c.id, c.generation, c.expires_at AS "expiresAt", c.retired_at AS "retiredAt", d.now
    FROM auth_browser_contexts c CROSS JOIN decision_clock d WHERE c.id = ${context.id}::uuid
      AND c.retired_at IS NULL AND c.expires_at > d.now`;
  if (!reread) throw unauthorized();
  if (BigInt(reread.generation) >= 9223372036854775807n) throw new AppError(409, 'auth_context_exhausted', 'Authentication context must be reset');
  const acceptedAt = reread.now;
  const recent = await tx.authBrowserIntent.count({ where: { contextId: reread.id, acceptedAt: { gte: new Date(acceptedAt.getTime() - 60_000) } } });
  if (recent >= 30) throw new AppError(429, 'rate_limited', 'Too many authentication attempts');
  const generation = BigInt(reread.generation) + 1n;
  const redeemUntil = new Date(Math.min(acceptedAt.getTime() + 12 * 60 * 1000, reread.expiresAt.getTime()));
  await tx.authBrowserContext.update({ where: { id: reread.id }, data: { generation } });
  const intent = await tx.authBrowserIntent.create({ data: { contextId: reread.id, actionId, kind, generation, acceptedAt, redeemUntil, claimedAt: kind === 'google' ? null : acceptedAt, logoutOutcome: kind.startsWith('logout') ? logoutOutcome : null } });
  if (currentReceipt) {
    const supersededAt = new Date(Math.max(acceptedAt, currentReceipt.activatedAt));
    await tx.authBrowserIntent.update({ where: { id: currentReceipt.id }, data: { supersededAt } });
    await tx.authSession.updateMany({ where: { browserIntentId: currentReceipt.id, tokenFamilyId: currentReceipt.tokenFamilyId, userId: currentReceipt.sessionUserId, revokedAt: null }, data: { revokedAt: acceptedAt } });
    await tx.securityEvent.create({ data: { eventType: 'authentication.google_intent_superseded', occurredAt: acceptedAt, eventMetadata: {} } });
  }
  return { duplicate: false, intent };
}

export function registerBrowserContextRoutes(app, { prisma, settings, redisClient }) {
  app.post('/api/v1/auth/browser-context', async (request, response, next) => {
    try {
      response.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
      if (guardedCookieCount(request, BROWSER_CONTEXT_COOKIE) > 1) throw unauthorized();
      if (!validateBrowserRequest(request, settings, 'x-acadboost-browser-auth')) throw new AppError(403, 'origin_not_allowed', 'Browser authentication request is not allowed');
      if (request.body && !Array.isArray(request.body) && request.body.reset === true && Object.keys(request.body).length === 1) {
        const digest = contextProofDigest(request);
        if (digest) {
          try {
            await eligibleContext(prisma, digest);
            throw new AppError(409, 'auth_context_active', 'A live browser context cannot be reset');
          } catch (error) {
            if (!(error instanceof AppError) || error.status !== 401) throw error;
          }
        }
        if (hasBrowserContext(request)) response.clearCookie(BROWSER_CONTEXT_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
        return response.sendStatus(204);
      }
      if (!request.body || Array.isArray(request.body) || Object.keys(request.body).length !== 0) throw new AppError(422, 'validation_error', 'Request body must be an empty JSON object');
      if (!settings.googleHandoffEnabled) throw new AppError(503, 'unavailable', 'Browser authentication context is unavailable');
      if (!redisClient) throw new AppError(503, 'unavailable', 'Browser authentication context is unavailable');
      const addressHash = createHash('sha256').update(String(request.ip ?? request.socket?.remoteAddress ?? 'unknown')).digest('hex');
      const rateKey = `outpost:auth-browser-bootstrap:v1:${addressHash}`;
      let count;
      try { count = Number(await redisClient.eval(BOOTSTRAP_RATE_SCRIPT, { keys: [rateKey], arguments: ['60'] })); }
      catch { throw new AppError(503, 'unavailable', 'Browser authentication context is unavailable'); }
      if (!Number.isSafeInteger(count) || count < 1) throw new AppError(503, 'unavailable', 'Browser authentication context is unavailable');
      if (count > 10) throw new AppError(429, 'rate_limited', 'Too many authentication attempts');
      const digest = contextProofDigest(request);
      if (digest) {
        try {
          const current = await eligibleContext(prisma, digest);
          return response.status(200).json({ context_id: current.id });
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 401) throw error;
        }
      }
      const bytes = randomBytes(32);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + MAX_AGE_MS);
      const context = await prisma.authBrowserContext.create({ data: { bindingDigest: createHash('sha256').update(bytes).digest(), createdAt: now, expiresAt } });
      response.cookie(BROWSER_CONTEXT_COOKIE, bytes.toString('base64url'), { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: MAX_AGE_MS });
      if (redisClient) await cleanupBrowserContexts(prisma);
      return response.status(200).json({ context_id: context.id });
    } catch (error) { return next(error); }
  });
}
export async function cleanupBrowserContexts(prisma, batchSize = 100) {
  return prisma.$transaction(async tx => {
    const expired = await tx.$queryRaw`SELECT c.id FROM auth_browser_contexts c
      WHERE c.expires_at <= clock_timestamp() AND (
        c.retired_at IS NULL OR EXISTS (
          SELECT 1 FROM auth_browser_intents i WHERE i.context_id = c.id AND (
            i.token_family_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM auth_sessions s WHERE s.browser_intent_id = i.id
            )
          )
        )
      )
      ORDER BY CASE WHEN c.retired_at IS NULL THEN 0 ELSE 1 END, c.expires_at
      LIMIT ${batchSize} FOR UPDATE OF c SKIP LOCKED`;
    for (const row of expired) {
      const [clock] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
      await tx.authBrowserContext.updateMany({ where: { id: row.id, retiredAt: null }, data: { bindingDigest: null, retiredAt: clock.now } });
      await tx.authBrowserIntent.deleteMany({ where: { contextId: row.id, tokenFamilyId: null } });
      await tx.authBrowserIntent.deleteMany({ where: { contextId: row.id, tokenFamilyId: { not: null }, authSessions: { none: {} } } });
      await tx.authBrowserContext.deleteMany({ where: { id: row.id, intents: { none: {} } } });
    }
    return expired.length;
  });
}
