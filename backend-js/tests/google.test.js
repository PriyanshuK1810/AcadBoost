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
import { createValkeyClient } from '../src/core/valkey.js';

const baseSettings = {
  env: 'test',
  googleClientId: 'test-client.apps.googleusercontent.com',
  googleClientSecret: 'test-only-secret',
  googleRedirectUri: 'https://api.example.com/api/v1/auth/google/callback',
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
    async set(key, value, options) {
      if (options.NX && values.has(key)) return null;
      values.set(key, { value, options });
      return 'OK';
    },
    async eval(_script, { keys: [key], arguments: [proof] }) {
      const entry = values.get(key);
      if (!entry) return null;
      const record = JSON.parse(entry.value);
      if (record.correlationDigest !== proof) return null;
      values.delete(key);
      return [record.nonce, record.codeVerifier];
    },
  };
}

function fakePrisma() {
  const users = [];
  const identities = [];
  const sessions = [];
  const events = [];
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
    oauthIdentity: {
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
    },
    securityEvent: { async create({ data }) { events.push(data); } },
    async $queryRaw() { return []; },
    async $transaction(callback) { return callback(prisma); },
  };
  return { prisma, users, identities, sessions, events };
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
  app.use(cookieParser());
  registerGoogleRoutes(app, { prisma, settings, redisClient, fetchImpl });
  app.use(errorHandler);
  return app;
}

const correlationHeader = (response) => response.headers['set-cookie']?.find((cookie) => cookie.startsWith(`${cookieName}=`));

function browserFor(app) {
  const agent = request.agent(app);
  // Supertest uses HTTP. Track each simulated browser's Secure cookie separately.
  let proof;
  const accept = (response) => {
    const header = correlationHeader(response);
    if (header) proof = header.split(';', 1)[0].slice(cookieName.length + 1) || undefined;
    return response;
  };
  return {
    get proof() { return proof; },
    async start() {
      const response = accept(await agent.get(authorizePath));
      expect(response.status).toBe(302);
      const { searchParams } = new URL(response.headers.location);
      return { state: searchParams.get('state'), nonce: searchParams.get('nonce'), response };
    },
    async callback(state, { code = 'one-time-code', iss = discovery.issuer, cookie = proof } = {}) {
      const pending = agent.get(callbackPath).query({ state, code, iss });
      if (cookie) pending.set('Cookie', `${cookieName}=${cookie}`);
      return accept(await pending);
    },
  };
}

function fixture({ redis = fakeRedis(), google = fakeGoogle(), db = fakePrisma() } = {}) {
  const app = appFor({ prisma: db.prisma, redisClient: redis, fetchImpl: google.fetch.bind(google) });
  return { db, redis, google, browser: () => browserFor(app) };
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
  it('denies a copied callback before provider or database work and preserves the initiating attempt', async () => {
    const context = fixture();
    const browserA = context.browser();
    const browserB = context.browser();
    const attempt = await browserA.start();
    const otherAttempt = await browserB.start();
    context.google.nonce = attempt.nonce;

    const denied = await browserB.callback(attempt.state);

    expect(denied.status).toBe(401);
    expect(correlationHeader(denied)).toBeUndefined();
    expectNoAuthentication(context);
    expect(context.redis.values.has(stateKey(attempt.state))).toBe(true);
    expect(context.redis.values.has(stateKey(otherAttempt.state))).toBe(true);
    expect((await browserA.callback(attempt.state)).status).toBe(200);
    expect(context.db.sessions).toHaveLength(1);
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
    expect((await request(appFor({ settings: {}, redisClient: fakeRedis() })).get(callbackPath)).status).toBe(503);
    expect((await request(appFor()).get(authorizePath)).status).toBe(503);
  });

  it('verifies a signed callback, creates one identity, issues a session, clears proof and rejects replay', async () => {
    const context = fixture();
    const { db, redis, google } = context;
    const browser = context.browser();
    const { state, nonce } = await browser.start();
    const proof = browser.proof;
    const { codeVerifier } = JSON.parse(redis.values.get(stateKey(state)).value);
    google.nonce = nonce;
    const response = await browser.callback(state);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ token_type: 'bearer', expires_in: 900 });
    expect(response.body.access_token).toBeTruthy();
    expect(response.headers['cache-control']).toBe('no-store');
    expectCorrelationCleared(response);
    expect(browser.proof).toBeUndefined();
    const refresh = response.headers['set-cookie'].find((cookie) => cookie.startsWith('outpost_refresh='));
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
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toBe('Invalid Google authentication response');
    expect(correlationHeader(replay)).toBeUndefined();
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
    expect(response.status).toBe(401);
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
    expect(response.status).toBe(401);
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
    const browser = context.browser();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { state, nonce } = await browser.start();
      google.nonce = nonce;
      expect((await browser.callback(state)).status).toBe(200);
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
    await db.prisma.oauthIdentity.create({ data: {
      userId: suspended.id, provider: 'google', providerSubject: 'stable-google-subject',
      providerEmail: 'person@example.com',
    } });
    const browser = context.browser();
    const { state, nonce } = await browser.start();
    google.nonce = nonce;
    const response = await browser.callback(state);
    expect(response.status).toBe(401);
    expectCorrelationCleared(response);
    expect(response.headers['set-cookie'].some((cookie) => cookie.startsWith('outpost_refresh='))).toBe(false);
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
    expect(rejected.status).toBe(401);
    expect(correlationHeader(rejected)).toBeUndefined();
    expect(browser.proof).toBe(newProof);
    expectNoAuthentication(context);
    expect(context.redis.values.has(stateKey(older.state))).toBe(true);
    expect(context.redis.values.has(stateKey(latest.state))).toBe(true);
    expect((await browser.callback(latest.state)).status).toBe(200);
    expect(context.db.sessions).toHaveLength(1);
  });
});

const valkeyPort = Number(process.env.M01A_TEST_VALKEY_PORT);
describe.skipIf(!valkeyPort)('Google OAuth with disposable Valkey', () => {
  async function withValkey(test) {
    if (!Number.isInteger(valkeyPort) || valkeyPort < 1024 || valkeyPort === 6379 || valkeyPort > 65535) {
      throw new Error('Use a dedicated loopback Valkey test port');
    }
    const url = 'redis://127.0.0.1:' + valkeyPort;
    const redis = createValkeyClient(url);
    const control = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    const created = [];
    const context = fixture({ redis });
    try {
      await control.connect();
      const browser = context.browser();
      const { state, nonce } = await browser.start();
      const key = stateKey(state);
      created.push(key);
      context.google.nonce = nonce;
      await test({ ...context, initiator: browser, control, state, key });
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
      const { initiator, control, state, key, google, db } = context;
      const ttl = await control.pTTL(key);
      expect(ttl).toBeGreaterThan(590000);
      expect(ttl).toBeLessThanOrEqual(600000);
      const raw = await control.get(key);
      const wrong = await context.browser().callback(state, { cookie: randomBytes(32).toString('base64url') });
      expect(wrong.status).toBe(401);
      expect(await control.get(key)).toBe(raw);
      expect(await control.pTTL(key)).toBeGreaterThan(0);
      expect(await control.pTTL(key)).toBeLessThanOrEqual(ttl);
      expectNoAuthentication(context);

      const proof = initiator.proof;
      const replies = await Promise.all(Array.from({ length: 6 }, () => context.browser().callback(state, { cookie: proof })));
      expect(replies.map(({ status }) => status).sort()).toEqual([200, 401, 401, 401, 401, 401]);
      expect(replies.filter((reply) => correlationHeader(reply))).toHaveLength(1);
      expect(await control.exists(key)).toBe(0);
      expect((await context.browser().callback(state, { cookie: proof })).status).toBe(401);
      expect(google.calls.filter(({ url }) => url === discovery.token_endpoint)).toHaveLength(1);
      expect(db.identities).toHaveLength(1);
      expect(db.sessions).toHaveLength(1);
      expect(db.events).toHaveLength(1);
    }));

  it('denies an actually expired state before provider and database work', () =>
    withValkey(async (context) => {
      await context.control.pExpire(context.key, 30);
      await expect.poll(() => context.control.exists(context.key)).toBe(0);
      const response = await context.initiator.callback(context.state);
      expect(response.status).toBe(401);
      expect(correlationHeader(response)).toBeUndefined();
      expectNoAuthentication(context);
    }));

  it.each(['invalid JSON', 'invalid fields', 'wrong key type'])('denies malformed state with %s safely', (kind) =>
    withValkey(async (context) => {
      const { control, key, state, initiator } = context;
      if (kind === 'invalid JSON') await control.set(key, '{not-json', { EX: 60 });
      if (kind === 'invalid fields') {
        const record = JSON.parse(await control.get(key));
        await control.set(key, JSON.stringify({ ...record, codeVerifier: [] }), { EX: 60 });
      }
      if (kind === 'wrong key type') {
        await control.del(key);
        await control.hSet(key, 'test', 'wrong-type');
      }
      const response = await initiator.callback(state);
      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid Google authentication response');
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
      expect(response.status).toBe(503);
      expect(response.body.error.message).toBe('Google authentication is unavailable');
      expect(response.headers['set-cookie']).toBeUndefined();
      expectNoAuthentication(context);
    } finally {
      await redis.close();
      await new Promise((resolve) => endpoint.close(resolve));
    }
  });
});
