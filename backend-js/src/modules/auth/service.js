import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { conflict, notFound, notReady, unauthorized } from '../../core/errors.js';
import { contextProofDigest, guardedCookieCount, guardedHeaderValues } from './browserIntents.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './passwords.js';
import { decodeAccessToken, issueAccessToken } from './tokens.js';

const REFRESH_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_COOKIE = 'outpost_refresh';
export const COOKIE_PATH = '/api/v1/auth';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const newRefresh = () => randomBytes(32).toString('base64url');
const expiry = (now) => new Date(now.getTime() + REFRESH_SECONDS * 1000);
const eventData = (request) => ({
  userAgent: request.get('user-agent')?.slice(0, 512) || null,
  ipAddress: null,
});

export function setRefreshCookie(response, refresh, expiresAt) {
  response.cookie(REFRESH_COOKIE, refresh, {
    maxAge: expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) * 1000
      : REFRESH_SECONDS * 1000,
    path: COOKIE_PATH,
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
  });
}

export function clearRefreshCookie(response) {
  response.clearCookie(REFRESH_COOKIE, {
    path: COOKIE_PATH,
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
  });
}

export function publicUser(user) {
  return {
    id: user.id,
    display_name: user.displayName,
    username: user.username,
    primary_email: user.primaryEmail,
    email_verified_at: user.emailVerifiedAt?.toISOString() ?? null,
    account_type: user.accountType,
  };
}

export async function registerUser(prisma, data) {
  const passwordHash = await hashPassword(data.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          displayName: data.display_name,
          username: data.username,
          primaryEmail: data.email,
          accountType: data.account_type,
        },
      });
      await tx.passwordCredential.create({ data: { userId: user.id, passwordHash } });
      return user;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict('Registration cannot be completed with these identifiers');
    }
    throw error;
  }
}

export async function authenticatePassword(prisma, identifier, password) {
  const candidate = identifier.trim().toLowerCase();
  const isEmail = candidate.includes('@');
  const normalized = isEmail
    ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : '')
    : (/^[a-z0-9_]{3,64}$/.test(candidate) ? candidate : '');
  const user = normalized ? await prisma.user.findFirst({
    where: isEmail
      ? { primaryEmail: { equals: normalized, mode: 'insensitive' } }
      : { username: { equals: normalized, mode: 'insensitive' } },
    include: { passwordCredential: true },
  }) : null;
  const encoded = user?.passwordCredential?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const valid = await verifyPassword(encoded, password.length <= 1024 ? password : '');
  if (!valid || !user?.passwordCredential || user.status !== 'active') {
    throw unauthorized('Invalid credentials');
  }
  return user;
}

export async function issueSession(prisma, settings, user, method, request) {
  const issued = await prisma.$transaction((tx) => createSession(tx, settings, user, method, request));
  return signSession(settings, issued);
}

export async function createSession(tx, settings, user, method, request, binding) {
  if (!settings.authSigningKey) throw notReady('Authentication is not configured');
  if (user.status !== 'active') throw unauthorized('Authentication failed');
  const now = new Date();
  const refresh = newRefresh();
  const metadata = eventData(request);
  const expiresAt = binding ? new Date(Math.min(expiry(now), binding.expiresAt)) : expiry(now);
  if (expiresAt <= now) throw unauthorized('Authentication failed');
  const created = await tx.authSession.create({
    data: {
      id: randomUUID(),
      userId: user.id,
      tokenFamilyId: binding?.tokenFamilyId ?? randomUUID(),
      ...(binding && { browserIntentId: binding.intentId }),
      refreshTokenHash: digest(refresh),
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      ...metadata,
    },
  });
  await tx.securityEvent.create({
    data: {
      userId: user.id,
      sessionId: created.id,
      eventType: 'authentication.succeeded',
      eventMetadata: { method },
      ...metadata,
    },
  });
  return { userId: user.id, sessionId: created.id, refresh, expiresAt: binding ? expiresAt : undefined };
}

export async function signSession(settings, { userId, sessionId, refresh, expiresAt }) {
  return { access: await issueAccessToken(settings, userId, sessionId), refresh, expiresAt };
}

function familyScope(session) {
  return {
    tokenFamilyId: session.tokenFamilyId, userId: session.userId, browserIntentId: session.browserIntentId ?? null,
  };
}

async function eligibleFencedUser(prisma, session, settings, request, allowReplaced = false) {
  const proof = request && contextProofDigest(request);
  if (!proof || !settings?.publicAppOrigin) return null;
  const [user] = await prisma.$queryRaw`
    SELECT u.id, u.display_name AS "displayName", u.username, u.primary_email AS "primaryEmail",
           u.email_verified_at AS "emailVerifiedAt", u.account_type AS "accountType",
           c.expires_at AS "contextExpiresAt"
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN auth_browser_intents i
      ON i.id = s.browser_intent_id AND i.token_family_id = s.token_family_id AND i.session_user_id = s.user_id
    JOIN auth_browser_contexts c ON c.id = i.context_id
    WHERE s.id = ${session.id}::uuid AND u.id = ${session.userId}::uuid AND u.status = 'active'
      AND ((s.revoked_at IS NULL AND s.replaced_by_session_id IS NULL)
           OR (${allowReplaced} AND s.replaced_by_session_id IS NOT NULL))
      AND (s.expires_at > clock_timestamp() OR (${allowReplaced} AND s.replaced_by_session_id IS NOT NULL))
      AND i.kind = 'google' AND i.activated_at IS NOT NULL AND i.superseded_at IS NULL
      AND i.generation = c.generation AND c.retired_at IS NULL AND c.expires_at > clock_timestamp()
      AND c.binding_digest = ${proof}
  `;
  return user ?? null;
}

export async function rotateRefresh(prisma, settings, refreshToken, request) {
  const hash = digest(refreshToken);
  const metadata = eventData(request);
  const outcome = await prisma.$transaction(async (tx) => {
    const source = await tx.authSession.findUnique({ where: { refreshTokenHash: hash } });
    if (!source) throw unauthorized('Invalid or expired refresh credential');
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${source.userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: source.userId } });
    const current = await tx.authSession.findUnique({ where: { id: source.id } });
    if (!user || !current) throw unauthorized('Invalid or expired refresh credential');
    let contextExpiresAt;
    if (current.browserIntentId) {
      const origins = guardedHeaderValues(request, 'origin');
      const fenced = origins.length === 1 && origins[0] === settings.publicAppOrigin
        && guardedCookieCount(request, REFRESH_COOKIE) <= 1
        && await eligibleFencedUser(tx, current, settings, request, true);
      if (!fenced) throw unauthorized('Invalid or expired refresh credential');
      contextExpiresAt = fenced.contextExpiresAt;
    }
    const now = new Date();
    if (current.replacedBySessionId) {
      await tx.authSession.updateMany({
        where: { ...familyScope(current), revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.securityEvent.create({
        data: {
          userId: current.userId,
          sessionId: current.id,
          eventType: 'authentication.refresh_replay_detected',
          eventMetadata: { token_family_id: current.tokenFamilyId },
          ...metadata,
        },
      });
      return { replay: true };
    }
    if (current.revokedAt || current.expiresAt <= now || user.status !== 'active') {
      throw unauthorized('Invalid or expired refresh credential');
    }
    const nextRefresh = newRefresh();
    const expiresAt = contextExpiresAt ? new Date(Math.min(expiry(now), contextExpiresAt)) : expiry(now);
    if (expiresAt <= now) throw unauthorized('Invalid or expired refresh credential');
    const next = await tx.authSession.create({
      data: {
        id: randomUUID(),
        userId: current.userId,
        tokenFamilyId: current.tokenFamilyId,
        ...(current.browserIntentId && { browserIntentId: current.browserIntentId }),
        refreshTokenHash: digest(nextRefresh),
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
        ...metadata,
      },
    });
    await tx.authSession.update({
      where: { id: current.id },
      data: { lastUsedAt: now, revokedAt: now, replacedBySessionId: next.id },
    });
    await tx.securityEvent.create({
      data: {
        userId: current.userId,
        sessionId: next.id,
        eventType: 'authentication.refresh_rotated',
        eventMetadata: { previous_session_id: current.id },
        ...metadata,
      },
    });
    return { userId: user.id, sessionId: next.id, refresh: nextRefresh, expiresAt: contextExpiresAt ? expiresAt : undefined };
  });
  if (outcome.replay) throw unauthorized('Invalid or expired refresh credential');
  return signSession(settings, outcome);
}

export async function findRefreshSession(prisma, refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) return null;
  return prisma.authSession.findUnique({ where: { refreshTokenHash: digest(refreshToken) } });
}

// Read-only check for guarded Google activation. Do not rotate, revoke or record
// replay events when deciding whether an existing browser session blocks sign-in.
export async function findUsableRefreshSession(prisma, refreshToken, settings, request) {
  const session = await findRefreshSession(prisma, refreshToken);
  if (!session || session.revokedAt || session.replacedBySessionId || session.expiresAt <= new Date()) return null;
  if (session.browserIntentId) return await eligibleFencedUser(prisma, session, settings, request) ? session : null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  return user?.status === 'active' ? session : null;
}

export async function findAccessSession(prisma, settings, request, { userId, sessionId }) {
  const session = await prisma.authSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return null;
  if (session.browserIntentId) {
    const user = await eligibleFencedUser(prisma, session, settings, request);
    return user ? { user, session } : null;
  }
  if (session.revokedAt || session.replacedBySessionId || session.expiresAt <= new Date()) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user?.status === 'active' ? { user, session } : null;
}

export function createRequireUser(prisma, settings) {
  return async (request, _response, next) => {
    try {
      const authorization = request.get('authorization');
      if (!authorization?.startsWith('Bearer ')) throw unauthorized();
      const claims = await decodeAccessToken(settings, authorization.slice(7));
      const eligible = await findAccessSession(prisma, settings, request, claims);
      if (!eligible) throw unauthorized('Invalid or expired access credential');
      const { user, session } = eligible;
      request.user = publicUser(user);
      request.authSession = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function activeSessions(prisma, userId, currentId) {
  const now = new Date();
  const rows = await prisma.authSession.findMany({
    where: { userId, revokedAt: null, replacedBySessionId: null, expiresAt: { gt: now } },
    include: { browserIntent: { include: { context: true } } },
    orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.filter(({ browserIntentId, browserIntent }) => !browserIntentId || (
    browserIntent?.activatedAt && !browserIntent.supersededAt && !browserIntent.context.retiredAt
    && browserIntent.generation === browserIntent.context.generation && browserIntent.context.expiresAt > now
  )).map((row) => ({
    id: row.id,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    user_agent: row.userAgent,
    ip_address: row.ipAddress,
    is_current: row.id === currentId,
  }));
}

export async function revokeSession(prisma, userId, targetId, currentId) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const target = await tx.authSession.findFirst({ where: { id: targetId, userId } });
    if (!target) throw notFound('Session not found');
    const changed = await tx.authSession.updateMany({
      where: { ...familyScope(target), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (changed.count) {
      await tx.securityEvent.create({
        data: {
          userId,
          sessionId: target.id,
          eventType: 'authentication.session_revoked',
          eventMetadata: { current: targetId === currentId, token_family_id: target.tokenFamilyId },
        },
      });
    }
  });
}

export async function revokeAllSessions(prisma, userId, currentId) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    await revokeLogoutScope(tx, { id: currentId, userId }, true);
  });
}

export async function revokeCurrentSession(prisma, userId, currentId) {
  const session = await prisma.authSession.findUnique({ where: { id: currentId } });
  if (!session || session.userId !== userId) throw unauthorized('Invalid or expired access credential');
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    await revokeLogoutScope(tx, session, false);
  });
}

export async function revokeLogoutScope(tx, session, all) {
  const changed = await tx.authSession.updateMany({
    where: { ...(all ? { userId: session.userId } : familyScope(session)), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (changed.count) {
    await tx.securityEvent.create({
      data: {
        userId: session.userId,
        sessionId: session.id,
        eventType: all ? 'authentication.logout_all' : 'authentication.logout',
        eventMetadata: all ? { revoked_count: changed.count } : {},
      },
    });
  }
}
