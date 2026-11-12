import { z } from 'zod';
import { parseBody, registration, login } from '../../core/validation.js';
import { AppError, unauthorized } from '../../core/errors.js';
import {
  advanceBrowserIntent, browserActionId, findBrowserAction, findCurrentGoogleReceipt,
  guardedCookieCount, guardedHeaderValues, hasBrowserContext, lockBrowserContext, lockUserRows,
} from './browserIntents.js';
import { activateGoogleHandoff } from './googleHandoff.js';
import {
  activeSessions, createRequireUser, createSession, findAccessSession, findRefreshSession,
  findUsableRefreshSession, issueSession, publicUser, revokeLogoutScope, signSession,
  REFRESH_COOKIE, registerUser, authenticatePassword, revokeAllSessions,
  clearRefreshCookie, revokeCurrentSession, revokeSession, rotateRefresh, setRefreshCookie,
} from './service.js';
import { decodeAccessToken } from './tokens.js';

const UUID = z.uuid();

function tokenOutput(access) {
  return { access_token: access, token_type: 'bearer', expires_in: 900 };
}

function noStore(_request, response, next) {
  response.set('Cache-Control', 'no-store');
  next();
}
function tokenHeaders(response) {
  response.set('Pragma', 'no-cache');
}

const duplicateIntent = () => new AppError(409, 'auth_intent_already_submitted', 'This authentication action has already been submitted');

export async function acceptCredentialIntent(prisma, settings, request, kind) {
  if (!hasBrowserContext(request)) return null;
  const actionId = browserActionId(request, settings);
  return prisma.$transaction(async (tx) => {
    const context = await lockBrowserContext(tx, request, settings);
    if (await findBrowserAction(tx, context, actionId)) throw duplicateIntent();
    const receipt = await findCurrentGoogleReceipt(tx, context);
    await lockUserRows(tx, receipt ? [receipt.sessionUserId] : []);
    const result = await advanceBrowserIntent(tx, context, { actionId, kind });
    if (result.duplicate) throw duplicateIntent();
    return result.intent;
  });
}

export async function lockCredentialIntent(tx, settings, request, intent) {
  if (!intent) return;
  const context = await lockBrowserContext(tx, request, settings);
  if (context.id !== intent.contextId || context.generation !== intent.generation) {
    throw new AppError(409, 'auth_intent_superseded', 'A newer authentication action is already current');
  }
  await checkCredentialDeadline(tx, intent);
}

export async function checkCredentialDeadline(tx, intent) {
  if (!intent) return;
  const [{ now }] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
  if (intent.redeemUntil <= now) {
    throw new AppError(409, 'auth_intent_superseded', 'The authentication action has expired');
  }
}

async function logoutClaims(settings, request) {
  const header = request.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    return await decodeAccessToken(settings, header.slice(7));
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

function sameFamily(left, right) {
  return left && right && left.userId === right.userId && left.tokenFamilyId === right.tokenFamilyId
    && (left.browserIntentId ?? null) === (right.browserIntentId ?? null);
}

function keepRefreshCookie(request) {
  const values = guardedHeaderValues(request, 'x-acadboost-keep-refresh-cookie');
  if (values.length === 0) return false;
  if (values.length !== 1 || values[0] !== '1') {
    throw new AppError(422, 'validation_error', 'Invalid cookie preservation option');
  }
  return true;
}

function browserLogout(prisma, settings, requireUser, all) {
  return async (request, response, next) => {
    if (!hasBrowserContext(request)) return requireUser(request, response, next);
    const actionId = browserActionId(request, settings);
    const keepCookie = keepRefreshCookie(request);
    if (guardedCookieCount(request, REFRESH_COOKIE) > 1) throw unauthorized();
    if (request.body !== undefined || Number(request.get('Content-Length') || 0) > 0 ||
        request.get('Transfer-Encoding')) {
      throw new AppError(422, 'validation_error', 'This authentication action requires an empty body');
    }
    const kind = all ? 'logout_all' : 'logout';
    const claims = await logoutClaims(settings, request);
    const refreshToken = request.cookies?.[REFRESH_COOKIE];
    const result = await prisma.$transaction(async (tx) => {
      const context = await lockBrowserContext(tx, request, settings);
      const existing = await findBrowserAction(tx, context, actionId);
      if (existing) {
        if (existing.kind !== kind) throw duplicateIntent();
        return { completed: existing.logoutOutcome === 'completed' };
      }
      const receipt = await findCurrentGoogleReceipt(tx, context);
      await lockUserRows(tx, [claims?.userId, receipt?.sessionUserId].filter(Boolean));
      const access = claims && await findAccessSession(tx, settings, request, claims);
      const cookie = await findRefreshSession(tx, refreshToken);
      const fenceOwnsCookie = Boolean(receipt && cookie?.browserIntentId === receipt.id
        && cookie.tokenFamilyId === receipt.tokenFamilyId && cookie.userId === receipt.sessionUserId);
      const unrelated = !access && !all && !fenceOwnsCookie
        && await findUsableRefreshSession(tx, refreshToken, settings, request);
      const completed = Boolean(access || (!all && !unrelated));
      await advanceBrowserIntent(tx, context, { actionId, kind, logoutOutcome: completed ? 'completed' : 'denied' });
      if (access) await revokeLogoutScope(tx, access.session, all);
      const clear = fenceOwnsCookie || (all ? access && cookie?.userId === access.session.userId
        : sameFamily(cookie, access?.session));
      return { completed, clear };
    });
    if (!result.completed) throw unauthorized('Invalid or expired access credential');
    if (result.clear && !keepCookie) clearRefreshCookie(response);
    response.sendStatus(204);
  };
}

export function registerAuthRoutes(app, { prisma, settings, redisClient }) {
  const requireUser = createRequireUser(prisma, settings);
  app.post('/api/v1/auth/password/register', noStore, async (request, response) => {
    const data = parseBody(registration, request.body);
    const user = await registerUser(prisma, data);
    response.status(201).json(publicUser(user));
  });
  app.post('/api/v1/auth/password/login', noStore, async (request, response) => {
    const data = parseBody(login, request.body);
    const intent = await acceptCredentialIntent(prisma, settings, request, 'password');
    const user = await authenticatePassword(prisma, data.identifier, data.password);
    let credentials;
    if (intent) {
      const issued = await prisma.$transaction(async (tx) => {
        await lockCredentialIntent(tx, settings, request, intent);
        await lockUserRows(tx, [user.id]);
        await checkCredentialDeadline(tx, intent);
        const current = await tx.user.findUnique({ where: { id: user.id }, include: { passwordCredential: true } });
        if (current?.status !== 'active' || current.passwordCredential?.passwordHash !== user.passwordCredential.passwordHash) {
          throw unauthorized('Invalid credentials');
        }
        return createSession(tx, settings, current, 'password', request);
      });
      credentials = await signSession(settings, issued);
    } else {
      credentials = await issueSession(prisma, settings, user, 'password', request);
    }
    tokenHeaders(response);
    setRefreshCookie(response, credentials.refresh);
    response.json(tokenOutput(credentials.access));
  });
  app.post('/api/v1/auth/refresh', noStore, async (request, response) => {
    if (request.get('X-Acadboost-Google-Attempt') !== undefined) {
      return activateGoogleHandoff({ prisma, settings, redisClient, request, response });
    }
    const refresh = request.cookies[REFRESH_COOKIE];
    if (!refresh) throw new AppError(401, 'unauthorized', 'Invalid or expired refresh credential');
    const next = await rotateRefresh(prisma, settings, refresh, request);
    tokenHeaders(response);
    setRefreshCookie(response, next.refresh, next.expiresAt);
    response.json(tokenOutput(next.access));
  });
  app.get('/api/v1/me', noStore, requireUser, (request, response) => {
    response.json(request.user);
  });
  app.get('/api/v1/auth/sessions', noStore, requireUser, async (request, response) => {
    response.json(await activeSessions(prisma, request.user.id, request.authSession.id));
  });
  app.delete('/api/v1/auth/sessions/:session_id', noStore, requireUser, async (request, response) => {
    const parsed = UUID.safeParse(request.params.session_id);
    if (!parsed.success) {
      throw new AppError(422, 'validation_error', 'Request validation failed',
        [{ loc: ['path', 'session_id'], type: 'uuid_parsing' }]);
    }
    await revokeSession(prisma, request.user.id, parsed.data, request.authSession.id);
    if (parsed.data === request.authSession.id) clearRefreshCookie(response);
    response.sendStatus(204);
  });
  app.post('/api/v1/auth/logout-all', noStore, browserLogout(prisma, settings, requireUser, true), async (request, response) => {
    const keepCookie = keepRefreshCookie(request);
    await revokeAllSessions(prisma, request.user.id, request.authSession.id);
    if (!keepCookie) clearRefreshCookie(response);
    response.sendStatus(204);
  });
  app.post('/api/v1/auth/logout', noStore, browserLogout(prisma, settings, requireUser, false), async (request, response) => {
    const keepCookie = keepRefreshCookie(request);
    await revokeCurrentSession(prisma, request.user.id, request.authSession.id);
    if (!keepCookie) clearRefreshCookie(response);
    response.sendStatus(204);
  });
  return requireUser;
}
