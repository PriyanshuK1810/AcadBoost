import { createHash, randomBytes } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { AppError, forbidden, notReady, unauthorized } from '../../core/errors.js';
import {
  advanceBrowserIntent, findBrowserAction, findCurrentGoogleReceipt, guardedCookieCount,
  guardedHeaderValues, lockBrowserContext, lockUserRows, validateBrowserRequest,
} from './browserIntents.js';
import { createGoogleHandoff, currentGoogleIntent, GOOGLE_ATTEMPT_PATTERN, GOOGLE_UUID_LUA } from './googleHandoff.js';
import { findUsableRefreshSession, REFRESH_COOKIE } from './service.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DISCOVERY_ENDPOINT = 'https://accounts.google.com/.well-known/openid-configuration';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const INVALID = 'Invalid Google authentication response';
const CALLBACK_PATH = '/api/v1/auth/google/callback';
const CORRELATION_COOKIE = '__Secure-outpost_google_correlation';
const STATE_TTL_SECONDS = 600;
const CORRELATION_COOKIE_OPTIONS = { path: CALLBACK_PATH, secure: true, httpOnly: true, sameSite: 'lax' };
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const stateKey = (state) => `outpost:oauth-state:v1:${state}`;
const secret = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const failurePath = (result) => `/auth/google/complete?result=${result}`;

// Check the proof and consume state together. A mismatch leaves the record and TTL intact.
const consumeState = `
  local raw = redis.pcall('GET', KEYS[1])
  if type(raw) ~= 'string' then return nil end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' or record.correlationDigest ~= ARGV[1] then
    return nil
  end
  local function validSecret(value)
    return type(value) == 'string' and #value == 43 and string.match(value, '^[A-Za-z0-9_%-]+$')
  end
  local function validUuid(value)
    return type(value) == 'string' and string.match(value, '${GOOGLE_UUID_LUA}')
  end
  if not validSecret(record.nonce) or not validSecret(record.codeVerifier) or
     not validUuid(record.attemptId) or not validUuid(record.contextId) or not validUuid(record.intentId) or
     type(record.generation) ~= 'string' or #record.generation > 19 or
     (#record.generation == 19 and record.generation > '9223372036854775807') or
     not string.match(record.generation, '^[1-9][0-9]*$') then return nil end
  redis.call('DEL', KEYS[1])
  return { record.nonce, record.codeVerifier, record.attemptId, record.contextId, record.intentId, record.generation }
`;

async function getJson(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(10000), ...options });
    if (!response.ok) throw Error('Google HTTP request failed');
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Google JSON');
    return value;
  } catch {
    throw notReady('Google authentication is unavailable');
  }
}

async function verifiedPrincipal(settings, code, nonce, codeVerifier, fetchImpl) {
  const discovery = await getJson(fetchImpl, DISCOVERY_ENDPOINT, { headers: { Accept: 'application/json' } });
  if (discovery.issuer !== 'https://accounts.google.com' ||
      discovery.token_endpoint !== TOKEN_ENDPOINT || discovery.jwks_uri !== JWKS_ENDPOINT) {
    throw unauthorized(INVALID);
  }
  const form = new URLSearchParams({
    grant_type: 'authorization_code', code,
    client_id: settings.googleClientId, client_secret: settings.googleClientSecret,
    redirect_uri: settings.googleRedirectUri, code_verifier: codeVerifier,
  });
  const tokens = await getJson(fetchImpl, TOKEN_ENDPOINT, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (typeof tokens.id_token !== 'string') throw unauthorized(INVALID);
  const jwks = await getJson(fetchImpl, JWKS_ENDPOINT, { headers: { Accept: 'application/json' } });
  try {
    const header = decodeProtectedHeader(tokens.id_token);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !Array.isArray(jwks.keys)) throw Error('Header/JWKS');
    const matching = jwks.keys.filter((key) => key.kid === header.kid);
    if (matching.length !== 1) throw Error('Signing key');
    const key = await importJWK(matching[0], 'RS256');
    const { payload } = await jwtVerify(tokens.id_token, key, {
      algorithms: ['RS256'],
      issuer: ['accounts.google.com', 'https://accounts.google.com'],
      audience: settings.googleClientId,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce', 'email'],
    });
    if (payload.nonce !== nonce || payload.email_verified !== true ||
        (payload.azp && payload.azp !== settings.googleClientId)) throw Error('Claims');
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== settings.googleClientId) throw Error('AZP');
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw Error('Subject');
    if (typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) throw Error('Email');
    return {
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 200) : null,
    };
  } catch {
    throw unauthorized(INVALID);
  }
}

function requireGoogle(settings, redisClient) {
  if (settings.googleHandoffEnabled !== true || !settings.googleClientId ||
      !settings.googleClientSecret || !settings.googleRedirectUri || !settings.authSigningKey) {
    throw notReady('Google authentication is not configured');
  }
  if (!redisClient) throw notReady('Google authentication is unavailable');
}

function liveUnclaimed(intent, context) {
  return intent?.kind === 'google' && !intent.claimedAt && intent.generation === context.generation
    && intent.redeemUntil > new Date();
}

export function registerGoogleRoutes(app, { prisma, settings, redisClient, fetchImpl = fetch }) {
  app.get('/api/v1/auth/google/availability', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    requireGoogle(settings, redisClient);
    if (request.get('Sec-Fetch-Site') !== 'same-origin') throw notReady('Google authentication is unavailable');
    try {
      await Promise.all([redisClient.ping(), prisma.$queryRaw`SELECT 1 FROM auth_browser_contexts LIMIT 1`]);
    } catch {
      throw notReady('Google authentication is unavailable');
    }
    response.sendStatus(204);
  });

  app.post('/api/v1/auth/google/intent', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    requireGoogle(settings, redisClient);
    const origins = guardedHeaderValues(request, 'origin');
    if (origins.length !== 1 || origins[0] !== settings.publicAppOrigin) throw forbidden();
    if (!validateBrowserRequest(request, settings, 'x-acadboost-browser-auth') ||
        guardedCookieCount(request, REFRESH_COOKIE) > 1) throw unauthorized(INVALID);
    const { attempt, context_id: contextId } = request.body ?? {};
    if (typeof attempt !== 'string' || !GOOGLE_ATTEMPT_PATTERN.test(attempt) ||
        typeof contextId !== 'string' || !GOOGLE_ATTEMPT_PATTERN.test(contextId) || Object.keys(request.body).length !== 2) {
      throw new AppError(422, 'validation_error', 'Invalid Google authentication intent');
    }
    const actionId = attempt.toLowerCase();
    await prisma.$transaction(async (tx) => {
      const context = await lockBrowserContext(tx, request, settings);
      if (context.id !== contextId.toLowerCase()) throw unauthorized(INVALID);
      const prior = await findBrowserAction(tx, context, actionId);
      if (liveUnclaimed(prior, context)) return;
      if (prior) throw new AppError(409, 'auth_intent_already_submitted', 'This authentication action has already been submitted');
      if (await findUsableRefreshSession(tx, request.cookies?.[REFRESH_COOKIE], settings, request)) {
        throw new AppError(409, 'session_conflict', 'A signed-in session already exists.');
      }
      const receipt = await findCurrentGoogleReceipt(tx, context);
      await lockUserRows(tx, receipt ? [receipt.sessionUserId] : []);
      await advanceBrowserIntent(tx, context, { actionId, kind: 'google' });
    });
    response.sendStatus(204);
  });

  app.get('/api/v1/auth/google/authorize', async (request, response) => {
    response.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
    requireGoogle(settings, redisClient);
    const attemptId = request.query.attempt;
    if (typeof attemptId !== 'string' || !GOOGLE_ATTEMPT_PATTERN.test(attemptId) ||
        request.get('Sec-Fetch-Site') !== 'same-origin') {
      throw unauthorized('Invalid Google authentication request');
    }
    const intent = await prisma.$transaction(async (tx) => {
      const context = await lockBrowserContext(tx, request, settings);
      const intent = await findBrowserAction(tx, context, attemptId.toLowerCase());
      if (!liveUnclaimed(intent, context)) throw unauthorized('Invalid Google authentication request');
      const [{ now }] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
      const claimedAt = new Date(Math.max(now, intent.acceptedAt));
      if (claimedAt >= intent.redeemUntil) throw unauthorized('Invalid Google authentication request');
      await tx.authBrowserIntent.update({ where: { id: intent.id }, data: { claimedAt } });
      return intent;
    });
    const ttl = Math.min(STATE_TTL_SECONDS, Math.floor((intent.redeemUntil.getTime() - Date.now()) / 1000));
    if (ttl < 1) throw unauthorized('Invalid Google authentication request');
    const correlation = secret();
    const correlationDigest = digest(correlation);
    let state, nonce, codeVerifier;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = secret();
      nonce = secret();
      codeVerifier = secret();
      let stored;
      try {
        stored = await redisClient.set(stateKey(state), JSON.stringify({
          nonce, codeVerifier, correlationDigest, attemptId: intent.actionId, contextId: intent.contextId,
          intentId: intent.id, generation: intent.generation.toString(),
        }), { EX: ttl, NX: true });
      } catch {
        throw notReady('Google authentication is unavailable');
      }
      if (stored) break;
      state = null;
    }
    if (!state) throw notReady('Google authentication is unavailable');
    const url = new URL(AUTH_ENDPOINT);
    for (const [key, value] of Object.entries({
      client_id: settings.googleClientId,
      redirect_uri: settings.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) url.searchParams.set(key, value);
    response.cookie(CORRELATION_COOKIE, correlation, {
      ...CORRELATION_COOKIE_OPTIONS, maxAge: ttl * 1000,
    });
    response.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).redirect(302, url.toString());
  });

  app.get(CALLBACK_PATH, async (request, response) => {
    response.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
    const redirectFailure = (result) => response.redirect(303, failurePath(result));
    if (settings.googleHandoffEnabled !== true || !settings.googleClientId ||
        !settings.googleClientSecret || !settings.googleRedirectUri || !settings.authSigningKey) {
      return redirectFailure('unavailable');
    }
    if (!redisClient) return redirectFailure('unavailable');
    const { state = '', code = '', iss = '', error = '' } = request.query;
    const proof = request.cookies?.[CORRELATION_COOKIE];
    if (typeof state !== 'string' || !secretPattern.test(state) ||
        typeof proof !== 'string' || !secretPattern.test(proof) || guardedCookieCount(request, CORRELATION_COOKIE) !== 1 ||
        typeof code !== 'string' || code.length > 4096 ||
        typeof iss !== 'string' || iss.length > 256 ||
        typeof error !== 'string' || error.length > 128) return redirectFailure('invalid');
    let correlation;
    try {
      correlation = await redisClient.eval(consumeState, { keys: [stateKey(state)], arguments: [digest(proof)] });
    } catch {
      return redirectFailure('unavailable');
    }
    if (!correlation) return redirectFailure('invalid');
    response.clearCookie(CORRELATION_COOKIE, CORRELATION_COOKIE_OPTIONS);
    if (error === 'access_denied') return redirectFailure('cancelled');
    if (error) return redirectFailure('unavailable');
    if (!code || !['accounts.google.com', 'https://accounts.google.com'].includes(iss)) {
      return redirectFailure('invalid');
    }
    try {
      const [nonce, codeVerifier, attemptId, contextId, intentId, generation] = correlation;
      if (![attemptId, contextId, intentId].every((id) => GOOGLE_ATTEMPT_PATTERN.test(id ?? ''))) {
        return redirectFailure('invalid');
      }
      const reference = { attemptId, contextId, intentId, generation };
      if (!await currentGoogleIntent(prisma, reference)) return redirectFailure('invalid');
      const principal = await verifiedPrincipal(settings, code, nonce, codeVerifier, fetchImpl);
      const intent = await currentGoogleIntent(prisma, reference);
      if (!intent) return redirectFailure('invalid');
      await createGoogleHandoff(redisClient, principal, intent, response);
      return response.redirect(303, '/auth/google/complete');
    } catch (error) {
      if (error?.status === 401) return redirectFailure('invalid');
      if (error?.status === 503) return redirectFailure('unavailable');
      console.error('google_oauth_callback_failed', {
        requestId: request.requestId,
        category: 'unexpected',
      });
      return redirectFailure('unavailable');
    }
  });
}
