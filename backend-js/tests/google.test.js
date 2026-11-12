import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createClient } from 'redis';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { errorHandler } from '../src/core/errors.js';
import { registerGoogleRoutes } from '../src/modules/auth/google.js';
import { registerAuthRoutes } from '../src/modules/auth/routes.js';
import { BROWSER_CONTEXT_COOKIE, registerBrowserContextRoutes } from '../src/modules/auth/browserIntents.js';
import { createValkeyClient } from '../src/core/valkey.js';

const baseSettings = {
  env: 'test',
  googleClientId: 'test-client.apps.googleusercontent.com',
  googleClientSecret: 'test-only-secret',
  googleRedirectUri: 'https://api.example.com/api/v1/auth/google/callback',
  googleHandoffEnabled: true,
  publicAppOrigin: 'https://api.example.com',
  authSigningKey: 'test-signing-key-with-at-least-thirty-two-bytes',
};
const discovery = {
  issuer: 'https://accounts.google.com',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};
const authorizePath = '/api/v1/auth/google/authorize';
const callbackPath = '/api/v1/auth/google/callback';
const cookieName = '__Secure-outpost_google_correlation';
const stateKey = (state) => 'outpost:oauth-state:v1:' + state;
const completePath = '/auth/google/complete';
function expectCallback(response, result) {
  expect(response.status).toBe(303);
  expect(response.headers.location).toBe(result ? completePath + '?result=' + result : completePath);
}
let privateKey;
let publicJwk;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
});

function fakeRedis() {
  const values = new Map();
  return {
    values,
    async ping() { return 'PONG'; },
    async set(key, value, options) {
      if (options.NX && values.has(key)) return null;
      values.set(key, { value, options });
      return 'OK';
    },
    async eval(script, { keys: [key], arguments: args }) {
      if (script.includes('INCR')) return 1;
      const entry = values.get(key);
      if (!entry) return null;
      let record;
      try { record = JSON.parse(entry.value); } catch { return null; }
      if (script.includes('record.correlationDigest')) {
        if (record.correlationDigest !== args[0] || !record.attemptId ||
            !/^[A-Za-z0-9_-]{43}$/.test(record.nonce ?? '') ||
            !/^[A-Za-z0-9_-]{43}$/.test(record.codeVerifier ?? '')) return null;
        values.delete(key);
        return [record.nonce, record.codeVerifier, record.attemptId, record.contextId, record.intentId, record.generation];
      }
      if (record.attemptId !== args[0] || record.contextId !== args[1] || record.generation !== args[2] ||
          record.expiresAt <= Number(args[3]) || !record.principal ||
          typeof record.principal.subject !== 'string' || typeof record.principal.email !== 'string') return null;
      if (args[4] === 'consume') values.delete(key);
      return JSON.stringify(record);
    },
  };
}

function fakePrisma() {
  const users = [];
  const identities = [];
  const sessions = [];
  const events = [];
  const browserContexts = [];
  const intents = [];
  const prisma = {
    user: {
      async findUnique({ where }) { return users.find((user) => user.id === where.id) ?? null; },
      async findFirst({ where }) {
        return users.find((user) => user.primaryEmail?.toLowerCase() === where.primaryEmail.equals.toLowerCase()) ?? null;
      },
      async create({ data }) {
        const user = { id: randomUUID(), status: 'active', accountType: 'student', username: null, ...data };
        users.push(user);
        return user;
      },
    },
    oAuthIdentity: {
      async findUnique({ where }) {
        const key = where.provider_providerSubject;
        return identities.find((row) => row.provider === key.provider && row.providerSubject === key.providerSubject) ?? null;
      },
      async create({ data }) {
        const row = { id: randomUUID(), ...data };
        identities.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = identities.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    authSession: {
      async create({ data }) {
        const row = { ...data, revokedAt: null, replacedBySessionId: null };
        sessions.push(row);
        return row;
      },
      async findUnique({ where }) {
        if (where.refreshTokenHash) return sessions.find((row) => row.refreshTokenHash === where.refreshTokenHash) ?? null;
        return sessions.find((row) => row.id === where.id) ?? null;
      },
      async updateMany({ where, data }) {
        const matches = sessions.filter((row) =>
          (!where.tokenFamilyId || row.tokenFamilyId === where.tokenFamilyId) &&
          (!where.userId || row.userId === where.userId) &&
          (where.revokedAt === undefined || row.revokedAt === where.revokedAt));
        for (const row of matches) Object.assign(row, data);
        return { count: matches.length };
      },
    },
    authBrowserContext: {
      async create({ data }) {
        const row = { id: randomUUID(), generation: 0n, retiredAt: null, ...data };
        browserContexts.push(row);
        return row;
      },
      async findUnique({ where }) { return browserContexts.find((row) => row.id === where.id) ?? null; },
      async update({ where, data }) {
        const row = browserContexts.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    authBrowserIntent: {
      async count() { return intents.length; },
      async findUnique({ where, include }) {
        const key = where.contextId_actionId;
        const row = intents.find((row) => key ? row.contextId === key.contextId && row.actionId === key.actionId : row.id === where.id);
        return include && row ? { ...row, context: browserContexts.find((item) => item.id === row.contextId) } : row ?? null;
      },
      async findFirst({ where }) {
        return intents.find((row) => row.contextId === where.contextId && row.generation === where.generation
          && row.kind === 'google' && row.activatedAt && !row.supersededAt) ?? null;
      },
      async create({ data }) {
        const row = { id: randomUUID(), activatedAt: null, ...data };
        intents.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = intents.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    securityEvent: { async create({ data }) { events.push(data); } },
    async $queryRaw(query, value) {
      const sql = query.join(' ');
      if (sql.includes('WHERE binding_digest')) {
        return browserContexts.filter((row) => Buffer.from(row.bindingDigest).equals(Buffer.from(value)));
      }
      if (sql.includes('decision_clock')) {
        return browserContexts.filter((row) => row.id === value).map((row) => ({ ...row, now: new Date() }));
      }
      if (sql.includes('SELECT clock_timestamp() AS now')) return [{ now: new Date() }];
      return [];
    },
    async $transaction(callback) { return callback(prisma); },
  };
  return { prisma, users, identities, sessions, events, intents };
}

async function signedToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    aud: baseSettings.googleClientId,
    sub: 'stable-google-subject',
    nonce: 'expected-nonce',
    email: 'Person@Example.com',
    email_verified: true,
    name: 'Google Person',
    iat: now,
    exp: now + 300,
    ...claims,
  };
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
}

function fakeGoogle(sign = signedToken) {
  const calls = [];
  return {
    calls,
    nonce: null,
    async fetch(url, options) {
      calls.push({ url, options });
      if (url === 'https://accounts.google.com/.well-known/openid-configuration') return Response.json(discovery);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ id_token: await sign({ nonce: this.nonce }) });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [publicJwk] });
      throw new Error('unexpected URL ' + url);
    },
  };
}

function appFor({ prisma, settings = baseSettings, redisClient, fetchImpl } = {}) {
  const app = express();
  app.use((_request, _response, next) => { _request.requestId = randomUUID(); next(); });
  app.use(express.json());
  app.use(cookieParser());
  registerAuthRoutes(app, { prisma, settings, redisClient });
  registerBrowserContextRoutes(app, { prisma, settings, redisClient });
  registerGoogleRoutes(app, { prisma, settings, redisClient, fetchImpl });
  app.use(errorHandler);
  return app;
}

const correlationHeader = (response) => response.headers['set-cookie']?.find((cookie) => cookie.startsWith(`${cookieName}=`));

function browserFor(app) {
  const agent = request.agent(app);
  // Supertest uses HTTP. Track each simulated browser's Secure cookie separately.
  let proof;
  let handoff;
  let binding;
  let contextId;
  const accept = (response) => {
    const header = correlationHeader(response);
    if (header) proof = header.split(';', 1)[0].slice(cookieName.length + 1) || undefined;
    const handoffHeader = response.headers['set-cookie']?.find((cookie) => cookie.startsWith('__Secure-outpost_google_handoff='));
    if (handoffHeader) handoff = handoffHeader.split(';', 1)[0].split('=', 2)[1] || undefined;
    return response;
  };
  return {
    get proof() { return proof; },
    get handoff() { return handoff; },
    async start(attempt = randomUUID()) {
      if (!binding) {
        const bootstrap = await agent.post('/api/v1/auth/browser-context')
          .set('Origin', baseSettings.publicAppOrigin).set('X-Acadboost-Browser-Auth', '1').send({});
        expect(bootstrap.status).toBe(200);
        binding = bootstrap.headers['set-cookie'].find((cookie) => cookie.startsWith(BROWSER_CONTEXT_COOKIE + '=')).split(';', 1)[0];
        contextId = bootstrap.body.context_id;
      }
      const intent = await agent.post('/api/v1/auth/google/intent')
        .set('Origin', baseSettings.publicAppOrigin).set('X-Acadboost-Browser-Auth', '1')
        .set('Cookie', binding).send({ context_id: contextId, attempt });
      expect(intent.status).toBe(204);
      const pending = agent.get(authorizePath).query({ attempt }).set('Sec-Fetch-Site', 'same-origin').set('Cookie', binding);
      const response = accept(await pending);
      expect(response.status).toBe(302);
      const { searchParams } = new URL(response.headers.location);
      return { attempt, state: searchParams.get('state'), nonce: searchParams.get('nonce'), response };
    },
    async callback(state, { code = 'one-time-code', iss = discovery.issuer, error, cookie = proof } = {}) {
      const query = { state, code, iss };
      if (error) query.error = error;
      const pending = agent.get(callbackPath).query(query);
      if (cookie) pending.set('Cookie', `${cookieName}=${cookie}`);
      return accept(await pending);
    },
    async activate(attempt, credential = handoff, options = {}) {
      const pending = agent.post('/api/v1/auth/refresh')
        .set('Origin', options.origin ?? baseSettings.publicAppOrigin)
        .set('X-Acadboost-Google-Attempt', options.attempt ?? attempt);
      const cookies = [binding, credential && '__Secure-outpost_google_handoff=' + credential,
        options.refreshCookie && 'outpost_refresh=' + options.refreshCookie].filter(Boolean);
      if (cookies.length) pending.set('Cookie', cookies.join('; '));
      if (options.body !== undefined) pending.send(options.body);
      return accept(await pending);
    },
  };
}

function fixture({ redis = fakeRedis(), google = fakeGoogle(), db = fakePrisma() } = {}) {
  const app = appFor({ prisma: db.prisma, redisClient: redis, fetchImpl: google.fetch.bind(google) });
  return { app, db, redis, google, browser: () => browserFor(app) };
}

function expectNoAuthentication({ db, google }) {
  expect(google.calls).toHaveLength(0);
  expect(db.users).toHaveLength(0);
  expect(db.identities).toHaveLength(0);
  expect(db.sessions).toHaveLength(0);
  expect(db.events).toHaveLength(0);
}

function expectCorrelationCleared(response) {
  expect(correlationHeader(response)).toMatch(new RegExp(`^${cookieName}=; Path=${callbackPath};`));
  expect(correlationHeader(response)).toContain('Expires=Thu, 01 Jan 1970');
}

describe('Google OAuth/OIDC routes', () => {
  it('creates a short-lived handoff and activates it only through the guarded refresh mode', async () => {
    const context = fixture();
    const browser = context.browser();
    const attemptId = randomUUID();
    const { state, nonce } = await browser.start(attemptId);
    context.google.nonce = nonce;

    const callback = await browser.callback(state);

    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe('/auth/google/complete');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    expect(callback.text).not.toContain('access_token');
    expect(callback.text).not.toContain('one-time-code');
    expect(callback.headers['set-cookie'].some((cookie) => cookie.startsWith('outpost_refresh='))).toBe(false);
    expect(context.db.sessions).toHaveLength(0);
    expect(context.db.users).toHaveLength(0);
    const handoffHeader = callback.headers['set-cookie'].find((cookie) => cookie.startsWith('__Secure-outpost_google_handoff='));
    expect(handoffHeader).toBeTruthy();
    const handoffAttrs = handoffHeader.split('; ').slice(1);
    expect(handoffAttrs).toEqual(expect.arrayContaining([
      'Path=/api/v1/auth/refresh', 'Max-Age=120', 'HttpOnly', 'Secure', 'SameSite=Strict',
    ]));
    const handoff = handoffHeader.split(';', 1)[0].split('=', 2)[1];
    const raw = context.redis.values.get('outpost:google-handoff:v1:' + createHash('sha256').update(handoff).digest('hex'));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw.value)).toMatchObject({ attemptId, principal: { subject: 'stable-google-subject', email: 'person@example.com' } });
    expect(raw.options).toEqual({ EX: 120, NX: true });

    const activated = await browser.activate(attemptId, handoff);

    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ token_type: 'bearer', expires_in: 900 });
    expect(activated.body.access_token).toBeTruthy();
    expect(activated.headers['set-cookie'].some((cookie) => cookie.startsWith('outpost_refresh='))).toBe(true);
    expect(activated.headers['set-cookie'].some((cookie) => cookie.startsWith('__Secure-outpost_google_handoff=;'))).toBe(true);
    expect(context.db.users).toHaveLength(1);
    expect(context.db.identities).toHaveLength(1);
    expect(context.db.sessions).toHaveLength(1);
    expect(context.db.events).toHaveLength(1);
    expect(context.db.sessions[0]).toMatchObject({
      browserIntentId: context.db.intents[0].id, tokenFamilyId: context.db.intents[0].tokenFamilyId,
    });
  });

  it('denies a copied callback before provider or database work and preserves the initiating attempt', async () => {
    const context = fixture();
    const browserA = context.browser();
    const browserB = context.browser();
    const attempt = await browserA.start();
    const otherAttempt = await browserB.start();
    context.google.nonce = attempt.nonce;

    const denied = await browserB.callback(attempt.state);

    expectCallback(denied, 'invalid');
    expect(correlationHeader(denied)).toBeUndefined();
    expectNoAuthentication(context);
    expect(context.redis.values.has(stateKey(attempt.state))).toBe(true);
    expect(context.redis.values.has(stateKey(otherAttempt.state))).toBe(true);
    expectCallback(await browserA.callback(attempt.state));
    expect(context.db.sessions).toHaveLength(0);
    expect((await browserA.activate(attempt.attempt)).status).toBe(200);
    expect(context.db.sessions).toHaveLength(1);
  });

  it('keeps a valid grant and existing session intact on conflict and rejects wrong selectors first', async () => {
    const context = fixture();
    const browser = context.browser();
    const { state, nonce, attempt } = await browser.start();
    context.google.nonce = nonce;
    expectCallback(await browser.callback(state));
    const owner = await context.db.prisma.user.create({ data: { displayName: 'Existing account' } });
    const refresh = randomBytes(32).toString('base64url');
    const control = await context.db.prisma.authSession.create({ data: {
      id: randomUUID(), userId: owner.id, tokenFamilyId: randomUUID(), expiresAt: new Date(Date.now() + 600_000),
      refreshTokenHash: createHash('sha256').update(refresh).digest('hex'),
    } });
    const pending = browser.handoff;
    const invalid = await browser.activate(attempt, pending, { refreshCookie: refresh, attempt: randomUUID() });
    expect(invalid.status).toBe(401);
    const conflict = await browser.activate(attempt, pending, { refreshCookie: refresh });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('session_conflict');
    expect(conflict.headers['set-cookie']).toBeUndefined();
    expect(control.revokedAt).toBeNull();
    expect(context.db.sessions).toHaveLength(1);
    expect((await browser.activate(attempt, pending)).status).toBe(200);
  });

  it('starts no-store authorization with a callback-only cookie, a digest, nonce and S256 PKCE', async () => {
    const context = fixture();
    const browser = context.browser();
    const { state, nonce, response } = await browser.start();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    const url = new URL(response.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(baseSettings.googleClientId);
    expect(url.searchParams.get('redirect_uri')).toBe(baseSettings.googleRedirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state).toHaveLength(43);
    expect(nonce).toHaveLength(43);
    expect(state).not.toBe(nonce);
    const entry = context.redis.values.get(stateKey(state));
    expect(entry.options).toEqual({ EX: 600, NX: true });
    const stored = JSON.parse(entry.value);
    expect(stored.nonce).toBe(nonce);
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(stored.codeVerifier).digest('base64url'),
    );
    const attrs = correlationHeader(response).split('; ').slice(1);
    expect(attrs).toEqual(expect.arrayContaining([
      'Path=' + callbackPath, 'Max-Age=600', 'Secure', 'HttpOnly', 'SameSite=Lax',
    ]));
    expect(attrs.some((attr) => /^Domain=/i.test(attr))).toBe(false);
    expect(Buffer.from(browser.proof, 'base64url')).toHaveLength(32);
    expect(stored.correlationDigest).toBe(createHash('sha256').update(browser.proof).digest('hex'));
    expect(entry.value.includes(browser.proof)).toBe(false);
    expect(response.headers.location.includes(browser.proof) || response.text.includes(browser.proof)).toBe(false);
  });

  it('fails safely without Google credentials or Valkey', async () => {
    const missingCredentials = await request(appFor({ settings: {}, redisClient: fakeRedis() })).get(authorizePath);
    expect(missingCredentials.status).toBe(503);
    expect(missingCredentials.body.error.message).toBe('Google authentication is not configured');
    expectCallback(await request(appFor({ settings: {}, redisClient: fakeRedis() })).get(callbackPath), 'unavailable');
    expect((await request(appFor()).get(authorizePath)).status).toBe(503);
  });

  it('verifies a signed callback, creates one identity, issues a session, clears proof and rejects replay', async () => {
    const context = fixture();
    const { db, redis, google } = context;
    const browser = context.browser();
    const { state, nonce, attempt } = await browser.start();
    const proof = browser.proof;
    const { codeVerifier } = JSON.parse(redis.values.get(stateKey(state)).value);
    google.nonce = nonce;
    const response = await browser.callback(state);
    expectCallback(response);
    expect(response.body.access_token).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expectCorrelationCleared(response);
    expect(browser.proof).toBeUndefined();
    expect(db.sessions).toHaveLength(0);
    const grant = browser.handoff;
    const activation = await browser.activate(attempt);
    expect(activation.status).toBe(200);
    expect(activation.body).toMatchObject({ token_type: 'bearer', expires_in: 900 });
    expect(activation.body.access_token).toBeTruthy();
    const refresh = activation.headers['set-cookie'].find((cookie) => cookie.startsWith('outpost_refresh='));
    expect(refresh).toMatch(/; Path=\/api\/v1\/auth;.*HttpOnly; Secure; SameSite=Strict/);
    expect(db.users).toHaveLength(1);
    expect(db.users[0].primaryEmail).toBe('person@example.com');
    expect(db.identities[0]).toMatchObject({
      userId: db.users[0].id, provider: 'google', providerSubject: 'stable-google-subject',
      providerEmail: 'person@example.com',
    });
    expect(db.sessions).toHaveLength(1);
    expect(db.events[0].eventMetadata.method).toBe('google_oidc');
    const tokenCall = google.calls.find(({ url }) => url === discovery.token_endpoint);
    const form = new URLSearchParams(tokenCall.options.body);
    expect(form.get('code_verifier')).toBe(codeVerifier);
    expect(form.get('code')).toBe('one-time-code');
    const replay = await browser.callback(state, { cookie: proof });
    expectCallback(replay, 'invalid');
    expect(correlationHeader(replay)).toBeUndefined();
    expect((await browser.activate(attempt, grant)).status).toBe(401);
    expect(google.calls.filter(({ url }) => url === discovery.token_endpoint)).toHaveLength(1);
    expect(db.sessions).toHaveLength(1);
  });

  it.each([
    ['absent', null],
    ['incorrect', randomBytes(32).toString('base64url')],
    ['malformed', 'not-a-correlation-secret'],
  ])('rejects %s browser proof without consuming state', async (_name, cookie) => {
    const context = fixture();
    const browser = context.browser();
    const { state } = await browser.start();
    const response = await browser.callback(state, { cookie });
    expectCallback(response, 'invalid');
    expect(correlationHeader(response)).toBeUndefined();
    expect(context.redis.values.has(stateKey(state))).toBe(true);
    expectNoAuthentication(context);
  });

  it.each([
    ['wrong callback issuer', { iss: 'https://evil.example' }],
    ['wrong token audience', { claims: { aud: 'other-client' } }],
    ['wrong token nonce', { claims: { nonce: 'different' } }],
    ['unverified email', { claims: { email_verified: false } }],
    ['unauthorized party', { claims: { azp: 'other-client' } }],
    ['expired token', { claims: { exp: 1 } }],
    ['invalid token', { invalidToken: true }],
  ])('rejects %s after proof consumption and clears the cookie', async (_name, override) => {
    const google = fakeGoogle((claims) => override.invalidToken ? 'not-a-token' : signedToken({ ...claims, ...override.claims }));
    const context = fixture({ google });
    const browser = context.browser();
    const { state, nonce } = await browser.start();
    google.nonce = nonce;
    const response = await browser.callback(state, { iss: override.iss });
    expectCallback(response, 'invalid');
    expectCorrelationCleared(response);
    expect(response.headers['set-cookie'].some((cookie) => cookie.startsWith('outpost_refresh='))).toBe(false);
    expect(context.db.users).toHaveLength(0);
    expect(context.db.sessions).toHaveLength(0);
    expect(context.redis.values.size).toBe(0);
    if (override.iss) expect(google.calls).toHaveLength(0);
  });

  it('keeps a colliding email separate and reuses only the linked Google subject', async () => {
    const context = fixture();
    const { db, google } = context;
    const original = await db.prisma.user.create({ data: {
      displayName: 'Password User', primaryEmail: 'person@example.com', emailVerifiedAt: new Date(),
    } });
    for (let index = 0; index < 2; index += 1) {
      const browser = context.browser();
      const { state, nonce, attempt } = await browser.start();
      google.nonce = nonce;
      expectCallback(await browser.callback(state));
      expect((await browser.activate(attempt)).status).toBe(200);
    }
    expect(db.users).toHaveLength(2);
    expect(db.identities).toHaveLength(1);
    expect(db.identities[0].userId).not.toBe(original.id);
    expect(db.users.find((user) => user.id === db.identities[0].userId).primaryEmail).toBeNull();
    expect(db.sessions).toHaveLength(2);
  });

  it('rejects a suspended linked user and clears proof without creating a session', async () => {
    const context = fixture();
    const { db, google } = context;
    const suspended = await db.prisma.user.create({ data: {
      displayName: 'Suspended', primaryEmail: null, status: 'suspended',
    } });
    await db.prisma.oAuthIdentity.create({ data: {
      userId: suspended.id, provider: 'google', providerSubject: 'stable-google-subject',
      providerEmail: 'person@example.com',
    } });
    const browser = context.browser();
    const { state, nonce, attempt } = await browser.start();
    google.nonce = nonce;
    const response = await browser.callback(state);
    expectCallback(response);
    expectCorrelationCleared(response);
    expect(response.headers['set-cookie'].some((cookie) => cookie.startsWith('outpost_refresh='))).toBe(false);
    const activation = await browser.activate(attempt);
    expect(activation.status).toBe(401);
    expect(activation.headers['set-cookie'].some((cookie) => cookie.startsWith('outpost_refresh='))).toBe(false);
    expect(db.sessions).toHaveLength(0);
  });

  it('uses the latest attempt in one cookie jar and leaves its cookie intact on an older callback', async () => {
    const context = fixture();
    const browser = context.browser();
    const older = await browser.start();
    const oldProof = browser.proof;
    const latest = await browser.start();
    const newProof = browser.proof;
    expect(newProof).not.toBe(oldProof);
    context.google.nonce = latest.nonce;
    const rejected = await browser.callback(older.state);
    expectCallback(rejected, 'invalid');
    expect(correlationHeader(rejected)).toBeUndefined();
    expect(browser.proof).toBe(newProof);
    expectNoAuthentication(context);
    expect(context.redis.values.has(stateKey(older.state))).toBe(true);
    expect(context.redis.values.has(stateKey(latest.state))).toBe(true);
    expectCallback(await browser.callback(latest.state));
    expect(context.db.sessions).toHaveLength(0);
    expect((await browser.activate(latest.attempt)).status).toBe(200);
    expect(context.db.sessions).toHaveLength(1);
  });
});

const valkeyPort = Number(process.env.M01A_TEST_VALKEY_PORT);
describe.skipIf(!valkeyPort)('Google OAuth with disposable Valkey', () => {
  async function withValkey(test) {
    if (!Number.isInteger(valkeyPort) || valkeyPort < 1024 || valkeyPort === 6379 || valkeyPort > 65535) {
      throw new Error('Use a dedicated loopback Valkey test port');
    }
    const url = 'redis://127.0.0.1:' + valkeyPort + '/2';
    const redis = createValkeyClient(url);
    const control = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    const created = [];
    const context = fixture({ redis });
    try {
      await control.connect();
      const browser = context.browser();
      const { state, nonce, attempt } = await browser.start();
      const key = stateKey(state);
      created.push(key);
      context.google.nonce = nonce;
      await test({ ...context, initiator: browser, control, state, key, attempt });
    } finally {
      try {
        if (control.isReady && created.length) await control.del(created);
      } finally {
        if (control.isOpen) await control.close();
        await redis.close();
      }
    }
  }

  it('keeps a mismatched state and TTL intact, then lets exactly one matching callback consume it', () =>
    withValkey(async (context) => {
      const { initiator, control, state, key, google, db, attempt } = context;
      const ttl = await control.pTTL(key);
      expect(ttl).toBeGreaterThan(590000);
      expect(ttl).toBeLessThanOrEqual(600000);
      const raw = await control.get(key);
      const wrong = await context.browser().callback(state, { cookie: randomBytes(32).toString('base64url') });
      expectCallback(wrong, 'invalid');
      expect(await control.get(key)).toBe(raw);
      expect(await control.pTTL(key)).toBeGreaterThan(0);
      expect(await control.pTTL(key)).toBeLessThanOrEqual(ttl);
      expectNoAuthentication(context);

      const proof = initiator.proof;
      const replies = await Promise.all(Array.from({ length: 6 }, () => initiator.callback(state, { cookie: proof })));
      for (const reply of replies) expect(reply.status).toBe(303);
      expect(replies.filter((reply) => reply.headers.location === completePath)).toHaveLength(1);
      expect(replies.filter((reply) => reply.headers.location === completePath + '?result=invalid')).toHaveLength(5);
      expect(replies.filter((reply) => correlationHeader(reply))).toHaveLength(1);
      expect(await control.exists(key)).toBe(0);
      expectCallback(await context.browser().callback(state, { cookie: proof }), 'invalid');
      expect(google.calls.filter(({ url }) => url === discovery.token_endpoint)).toHaveLength(1);
      expect(db.identities).toHaveLength(0);
      expect(db.sessions).toHaveLength(0);
      expect(db.events).toHaveLength(0);
      const grant = initiator.handoff;
      const activations = await Promise.all(Array.from({ length: 3 }, () => initiator.activate(attempt, grant)));
      expect(activations.map(({ status }) => status).sort()).toEqual([200, 401, 401]);
      expect(db.identities).toHaveLength(1);
      expect(db.sessions).toHaveLength(1);
      expect(db.events).toHaveLength(1);
    }));

  it('denies an actually expired state before provider and database work', () =>
    withValkey(async (context) => {
      await context.control.pExpire(context.key, 30);
      await expect.poll(() => context.control.exists(context.key)).toBe(0);
      const response = await context.initiator.callback(context.state);
      expectCallback(response, 'invalid');
      expect(correlationHeader(response)).toBeUndefined();
      expectNoAuthentication(context);
    }));

  it.each(['invalid JSON', 'invalid fields', 'invalid context ID', 'overflowing generation', 'wrong key type'])('denies malformed state with %s safely', (kind) =>
    withValkey(async (context) => {
      const { control, key, state, initiator } = context;
      if (kind === 'invalid JSON') await control.set(key, '{not-json', { EX: 60 });
      if (kind === 'invalid fields') {
        const record = JSON.parse(await control.get(key));
        await control.set(key, JSON.stringify({ ...record, codeVerifier: [] }), { EX: 60 });
      }
      if (kind === 'invalid context ID' || kind === 'overflowing generation') {
        const record = JSON.parse(await control.get(key));
        if (kind === 'invalid context ID') record.contextId = '00000000-0000-0000-0000-000000000000';
        else record.generation = '9223372036854775808';
        await control.set(key, JSON.stringify(record), { EX: 60 });
      }
      if (kind === 'wrong key type') {
        await control.del(key);
        await control.hSet(key, 'test', 'wrong-type');
      }
      const response = await initiator.callback(state);
      expectCallback(response, 'invalid');
      expect(correlationHeader(response)).toBeUndefined();
      expect(await control.exists(key)).toBe(1);
      expectNoAuthentication(context);
    }));

  it('fails closed when the Valkey transport is unavailable', async () => {
    const endpoint = createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      endpoint.once('error', reject);
      endpoint.listen(0, '127.0.0.1', resolve);
    });
    const redis = createValkeyClient('redis://127.0.0.1:' + endpoint.address().port);
    try {
      const context = fixture({ redis });
      const response = await context.browser().callback(randomBytes(32).toString('base64url'), {
        cookie: randomBytes(32).toString('base64url'),
      });
      expectCallback(response, 'unavailable');
      expect(response.headers['set-cookie']).toBeUndefined();
      expectNoAuthentication(context);
    } finally {
      await redis.close();
      await new Promise((resolve) => endpoint.close(resolve));
    }
  });
});
