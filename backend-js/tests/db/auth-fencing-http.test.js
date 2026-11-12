import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createValkeyClient } from '../../src/core/valkey.js';
import { createPrismaClient } from '../../src/db/client.js';
import { advanceBrowserIntent, BROWSER_CONTEXT_COOKIE } from '../../src/modules/auth/browserIntents.js';
import { createGoogleHandoff, GOOGLE_HANDOFF_COOKIE } from '../../src/modules/auth/googleHandoff.js';
import { DevelopmentSmsProvider } from '../../src/modules/auth/phone.js';
import { hashPassword } from '../../src/modules/auth/passwords.js';
import { createSession, issueSession, rotateRefresh, signSession } from '../../src/modules/auth/service.js';

const url = process.env.M01B_R1_DATABASE_URL;
const valkey = process.env.M01B_R1_VALKEY_URL;
const origin = 'https://app.example.test';
const settings = {
  env: 'test',
  authSigningKey: randomBytes(48).toString('base64url'),
  otpHmacKey: randomBytes(48).toString('base64url'),
  googleHandoffEnabled: true,
  publicAppOrigin: origin,
};
const password = 'synthetic-password-for-fencing';
const testTimeout = 30_000;
let prisma;
let redis;
let sms;
let api;
const metadata = { get: () => undefined };

async function startAuthProcess(valkeyUrl) {
  const child = fork(new URL('../helpers/auth-fencing-process.mjs', import.meta.url), {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env, M01B_R1_DATABASE_URL: url, M01B_R1_VALKEY_URL: valkeyUrl,
      M01B_R1_PROCESS_ORIGIN: origin, M01B_R1_PROCESS_SIGNING_KEY: settings.authSigningKey,
    },
  });
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Disposable auth process exited before readiness')));
    child.once('message', (message) => resolve(message.port));
  });
  return {
    api: request('http://127.0.0.1:' + port),
    async stop() {
      child.kill('SIGKILL');
      await stopped;
    },
  };
}

function app() {
  if (api) return api;
  const database = new URL(url);
  const store = new URL(valkey);
  if (!/^\/outpost_m01b_r1_[a-z0-9_]+$/.test(database.pathname) ||
      store.hostname !== '127.0.0.1' || Number(store.port) <= 1024 || store.port === '6379') {
    throw new Error('Explicit disposable PostgreSQL and Valkey endpoints are required');
  }
  store.pathname = '/4';
  prisma = createPrismaClient(database.href);
  redis = createValkeyClient(store.href);
  sms = new DevelopmentSmsProvider();
  api = request(createApp({ prisma, settings, redisClient: redis, smsProvider: sms }));
  return api;
}

afterAll(async () => {
  await redis?.close();
  await prisma?.$disconnect();
});

async function googleFixture({ active = true } = {}) {
  app();
  const bytes = randomBytes(32);
  const binding = BROWSER_CONTEXT_COOKIE + '=' + bytes.toString('base64url');
  const bindingDigest = createHash('sha256').update(bytes).digest();
  const expiresAt = new Date(Date.now() + 86_400_000);
  const { context, intent, issued, user } = await prisma.$transaction(async (tx) => {
    const context = await tx.authBrowserContext.create({ data: { bindingDigest, generation: 1n, expiresAt } });
    const now = new Date();
    const user = active ? await tx.user.create({ data: { displayName: 'Synthetic Google' } }) : null;
    const intent = await tx.authBrowserIntent.create({ data: {
      contextId: context.id, actionId: randomUUID(), kind: 'google', generation: 1n,
      acceptedAt: now, claimedAt: now, redeemUntil: new Date(now.getTime() + 600_000),
      ...(user && { activatedAt: now, sessionUserId: user.id, tokenFamilyId: randomUUID() }),
    } });
    const issued = user && await createSession(tx, settings, user, 'google_oidc', metadata, {
      intentId: intent.id, tokenFamilyId: intent.tokenFamilyId, expiresAt,
    });
    return { context, intent, issued, user };
  });
  return { context, intent, user, binding, ...(issued && await signSession(settings, issued)) };
}

function action(path, fixture, id = randomUUID(), originValue = origin) {
  return app().post('/api/v1/auth/' + path)
    .set('Origin', originValue).set('Cookie', fixture.binding).set('X-Acadboost-Auth-Intent', id);
}

function me(access, binding) {
  const query = app().get('/api/v1/me').set('Authorization', 'Bearer ' + access);
  return binding ? query.set('Cookie', binding) : query;
}

async function assertFenced(fixture) {
  const receipt = await prisma.authBrowserIntent.findUnique({ where: { id: fixture.intent.id } });
  expect(receipt.supersededAt).toBeInstanceOf(Date);
  expect(await prisma.authSession.count({ where: { browserIntentId: receipt.id, revokedAt: null } })).toBe(0);
  const refresh = await app().post('/api/v1/auth/refresh').set('Origin', origin)
    .set('Cookie', fixture.binding + '; outpost_refresh=' + fixture.refresh);
  expect(refresh.status).toBe(401);
  expect((await me(fixture.access, fixture.binding)).status).toBe(401);
}

async function passwordAccount() {
  const suffix = randomBytes(5).toString('hex');
  const email = 'r1-' + suffix + '@example.test';
  const registered = await app().post('/api/v1/auth/password/register').send({
    email, username: 'r1_' + suffix, password, display_name: 'Synthetic Password', account_type: 'student',
  });
  expect(registered.status).toBe(201);
  return { email, id: registered.body.id };
}

describe.skipIf(!url || !valkey)('browser intent HTTP integration with disposable PostgreSQL and Valkey', () => {
  it('I01 denies an older grant after logout commits without issuing any family', async () => {
    const fixture = await googleFixture({ active: false });
    let pending;
    await createGoogleHandoff(redis, { subject: randomUUID(), email: 'unused@example.test', name: null }, fixture.intent, {
      cookie(name, value) { if (name === GOOGLE_HANDOFF_COOKIE) pending = name + '=' + value; },
    });
    expect((await action('logout', fixture)).status).toBe(204);
    const result = await app().post('/api/v1/auth/refresh').set('Origin', origin)
      .set('X-Acadboost-Google-Attempt', fixture.intent.actionId).set('Cookie', fixture.binding + '; ' + pending);
    expect(result.status).toBe(401);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id } })).toBe(0);
  }, testTimeout);

  it('I03 serializes a waiting activation behind a newer intent that already owns the context lock', async () => {
    const fixture = await googleFixture({ active: false });
    let pending;
    await createGoogleHandoff(redis, { subject: randomUUID(), email: 'unused@example.test', name: null }, fixture.intent, {
      cookie(name, value) { if (name === GOOGLE_HANDOFF_COOKIE) pending = name + '=' + value; },
    });
    const fenced = Promise.withResolvers();
    const activationEntered = Promise.withResolvers();
    const real = prisma.$transaction.bind(prisma);
    const gated = {
      $queryRaw: prisma.$queryRaw.bind(prisma),
      authBrowserIntent: prisma.authBrowserIntent,
      $transaction: (operation, options) => real(async (tx) => {
        activationEntered.resolve();
        return operation(tx);
      }, options),
    };
    const activation = request(createApp({ prisma: gated, settings, redisClient: redis }))
      .post('/api/v1/auth/refresh').set('Origin', origin).set('X-Acadboost-Google-Attempt', fixture.intent.actionId)
      .set('Cookie', fixture.binding + '; ' + pending);
    const ordered = real(async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_browser_contexts WHERE id = ${fixture.context.id}::uuid FOR UPDATE`;
      fenced.resolve();
      await activationEntered.promise;
      await advanceBrowserIntent(tx, fixture.context, { actionId: randomUUID(), kind: 'logout', logoutOutcome: 'completed' });
    }, { timeout: 10_000 });
    await fenced.promise;
    const result = await activation;
    await ordered;
    expect(result.status).toBe(401);
    expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id } })).toBe(0);
  }, testTimeout);

  it('I02/I11 fences before a failed password and advances a repeated action only once', async () => {
    const fixture = await googleFixture();
    const { user } = fixture;
    const control = await issueSession(prisma, settings, user, 'test', metadata);
    expect((await me(fixture.access, fixture.binding)).status).toBe(200);
    const id = randomUUID();
    const credentials = { identifier: 'unknown@example.test', password };
    expect((await action('password/login', fixture, id).send(credentials)).status).toBe(401);
    await assertFenced(fixture);
    expect((await action('password/login', fixture, id).send(credentials)).status).toBe(409);
    expect((await action('logout', fixture, id)).status).toBe(409);
    expect((await prisma.authBrowserContext.findUnique({ where: { id: fixture.context.id } })).generation).toBe(2n);
    expect((await me(control.access)).status).toBe(200);
  }, testTimeout);

  it('I04 fences the Google account and issues an independent password session', async () => {
    const fixture = await googleFixture();
    const newer = await passwordAccount();
    const result = await action('password/login', fixture).send({ identifier: newer.email, password });
    expect(result.status).toBe(200);
    expect((await me(result.body.access_token)).body.id).toBe(newer.id);
    await assertFenced(fixture);
  }, testTimeout);

  it('I05/I06 preserves OTP request semantics and fences on failed and successful verification', async () => {
    const first = await googleFixture();
    const second = await googleFixture();
    const phone = '+1202555' + (1000 + Number.parseInt(randomBytes(2).toString('hex'), 16) % 8000);
    const challenge = await app().post('/api/v1/auth/phone/request').set('Cookie', first.binding).send({ phone });
    expect(challenge.status).toBe(202);
    expect((await prisma.authBrowserContext.findUnique({ where: { id: first.context.id } })).generation).toBe(1n);
    const code = sms.outbox.findLast((message) => message.to === phone).text.match(/\b\d{6}\b/)[0];
    const bad = await action('phone/verify', first).send({ phone, code: code === '000000' ? '000001' : '000000' });
    expect(bad.status).toBe(401);
    expect((await prisma.otpChallenge.findFirst({ where: { phoneE164: phone } })).attemptCount).toBe(1);
    await assertFenced(first);
    const good = await action('phone/verify', second).send({ phone, code });
    expect(good.status).toBe(200);
    const phoneIdentity = await prisma.phoneIdentity.findUnique({ where: { phoneE164: phone } });
    expect((await me(good.body.access_token)).body.id).toBe(phoneIdentity.userId);
    await assertFenced(second);
  }, testTimeout);

  it('I07/I08 preserves an unrelated cookie and requires a live bearer for account-wide logout', async () => {
    const first = await googleFixture();
    const second = await googleFixture();
    const third = await googleFixture();
    const unrelated = await prisma.user.create({ data: { displayName: 'Independent logout control' } });
    const control = await issueSession(prisma, settings, unrelated, 'test', metadata);
    const result = await action('logout', first).set('Cookie', first.binding + '; outpost_refresh=' + control.refresh);
    expect(result.status).toBe(401);
    expect(result.headers['set-cookie']).toBeUndefined();
    await assertFenced(first);
    expect((await action('logout-all', second)).status).toBe(401);
    await assertFenced(second);
    const sameUser = await issueSession(prisma, settings, third.user, 'test', metadata);
    expect((await action('logout-all', third).set('Authorization', 'Bearer ' + third.access)).status).toBe(204);
    expect((await me(sameUser.access)).status).toBe(401);
    await assertFenced(third);
    expect((await me(control.access)).status).toBe(200);
  }, testTimeout);

  it('I07 revokes the bound Google bearer without clearing a newer unrelated cookie', async () => {
    const fixture = await googleFixture();
    const unrelated = await prisma.user.create({ data: { displayName: 'Independent cookie owner' } });
    const control = await issueSession(prisma, settings, unrelated, 'test', metadata);
    const cookie = fixture.binding + '; outpost_refresh=' + control.refresh;
    const bad = await action('logout', fixture).set('Cookie', cookie).send({ scope: 'all' });
    expect(bad.status).toBe(422);
    expect((await me(fixture.access, fixture.binding)).status).toBe(200);
    const result = await action('logout', fixture).set('Cookie', cookie)
      .set('Authorization', 'Bearer ' + fixture.access);
    expect(result.status).toBe(204);
    expect(result.headers['set-cookie']).toBeUndefined();
    await assertFenced(fixture);
    expect((await me(control.access)).status).toBe(200);
  }, testTimeout);

  it('X01/X02 rejects foreign origin, duplicate proof and missing original proof', async () => {
    const fixture = await googleFixture();
    const payload = { identifier: 'unknown@example.test', password };
    expect((await action('password/login', fixture, randomUUID(), 'https://sibling.example.test').send(payload)).status).toBe(403);
    expect((await action('password/login', fixture, randomUUID(), 'null').send(payload)).status).toBe(403);
    const untrusted = await app().post('/api/v1/auth/password/login').set('Cookie', fixture.binding)
      .set('X-Forwarded-Host', 'app.example.test').set('X-Acadboost-Auth-Intent', randomUUID())
      .send(payload);
    expect(untrusted.status).toBe(403);
    const siblingForm = await app().post('/api/v1/auth/password/login').type('form')
      .set('Origin', 'https://sibling.example.test').set('Cookie', fixture.binding).send(payload);
    expect(siblingForm.status).toBe(422);
    expect((await action('password/login', fixture).set('Cookie', fixture.binding + '; ' + fixture.binding).send(payload)).status).toBe(401);
    expect((await me(fixture.access)).status).toBe(401);
    expect((await me(fixture.access, fixture.binding)).status).toBe(200);
    expect((await prisma.authBrowserContext.findUnique({ where: { id: fixture.context.id } })).generation).toBe(1n);
  }, testTimeout);

  it('X05 rate-limits accepted intents before advancement', async () => {
    const fixture = await googleFixture({ active: false });
    for (let i = 0; i < 29; i += 1) expect((await action('logout', fixture)).status).toBe(204);
    expect((await action('logout', fixture)).status).toBe(429);
    expect((await prisma.authBrowserContext.findUnique({ where: { id: fixture.context.id } })).generation).toBe(30n);
  }, testTimeout);

  it('X05 limits bootstrap to ten requests per minute for the same peer', async () => {
    app();
    const dedicated = new URL(valkey);
    dedicated.pathname = '/6';
    const cache = createValkeyClient(dedicated.href);
    const rateKey = 'outpost:auth-browser-bootstrap:v1:' + createHash('sha256').update('::ffff:127.0.0.1').digest('hex');
    try {
      const isolated = request(createApp({ prisma, settings, redisClient: cache }));
      const start = () => isolated.post('/api/v1/auth/browser-context')
        .set('Origin', origin).set('X-Acadboost-Browser-Auth', '1').send({});
      const { headers } = await start().expect(200);
      const proof = headers['set-cookie'][0].split(';', 1)[0];
      for (let i = 1; i < 10; i += 1) await start().set('Cookie', proof).expect(200);
      const denied = await start().set('Cookie', proof).expect(429);
      expect(denied.headers['set-cookie']).toBeUndefined();
    } finally {
      await cache.eval('return redis.call("DEL", KEYS[1])', { keys: [rateKey], arguments: [] });
      await cache.close();
    }
  }, testTimeout);

  it('S03 lets one ordinary rotation succeed and revokes the family on concurrent replay', async () => {
    const fixture = await googleFixture();
    const rotate = () => app().post('/api/v1/auth/refresh').set('Origin', origin)
      .set('Cookie', fixture.binding + '; outpost_refresh=' + fixture.refresh);
    const results = await Promise.all([rotate(), rotate()]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 401]);
    const rows = await prisma.authSession.findMany({ where: { tokenFamilyId: fixture.intent.tokenFamilyId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.browserIntentId === fixture.intent.id && row.revokedAt)).toBe(true);
    expect((await me(results.find((response) => response.status === 200).body.access_token, fixture.binding)).status).toBe(401);
  }, testTimeout);

  it('S03 revokes a live successor if an expired retained predecessor is replayed', async () => {
    const fixture = await googleFixture();
    const rotate = () => app().post('/api/v1/auth/refresh').set('Origin', origin)
      .set('Cookie', fixture.binding + '; outpost_refresh=' + fixture.refresh);
    const first = await rotate();
    expect(first.status).toBe(200);
    const old = await prisma.authSession.findUnique({
      where: { refreshTokenHash: createHash('sha256').update(fixture.refresh).digest('hex') },
    });
    await prisma.authSession.update({ where: { id: old.id }, data: {
      createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    } });
    expect((await rotate()).status).toBe(401);
    expect((await me(first.body.access_token, fixture.binding)).status).toBe(401);
  }, testTimeout);

  it('S04 denies suspended account credentials and preserves user-delete cascade for linked rows', async () => {
    const fixture = await googleFixture();
    await prisma.user.update({ where: { id: fixture.user.id }, data: { status: 'suspended' } });
    expect((await me(fixture.access, fixture.binding)).status).toBe(401);
    const rotation = await app().post('/api/v1/auth/refresh').set('Origin', origin)
      .set('Cookie', fixture.binding + '; outpost_refresh=' + fixture.refresh);
    expect(rotation.status).toBe(401);
    await prisma.user.delete({ where: { id: fixture.user.id } });
    expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id } })).toBe(0);
    expect(await prisma.authBrowserIntent.findUnique({ where: { id: fixture.intent.id } })).toBeTruthy();
  }, testTimeout);

  it('S04 rotation rereads status after waiting for a concurrent suspension', async () => {
    const fixture = await googleFixture();
    const suspendLocked = Promise.withResolvers();
    const rotationEntered = Promise.withResolvers();
    const transaction = prisma.$transaction.bind(prisma);
    const gated = {
      $transaction: (operation) => transaction(async (tx) => {
        const observed = {
          authSession: tx.authSession,
          user: tx.user,
          $queryRaw: (...args) => {
            rotationEntered.resolve();
            return tx.$queryRaw(...args);
          },
        };
        return operation(observed);
      }),
    };
    const suspend = transaction(async (tx) => {
      await tx.user.update({ where: { id: fixture.user.id }, data: { status: 'suspended' } });
      suspendLocked.resolve();
      await rotationEntered.promise;
    });
    await suspendLocked.promise;
    const rotating = rotateRefresh(gated, settings, fixture.refresh, {
      headers: { origin, cookie: fixture.binding + '; outpost_refresh=' + fixture.refresh },
      get(name) { return this.headers[name.toLowerCase()]; },
    });
    await expect(rotating).rejects.toMatchObject({ status: 401 });
    await suspend;
    expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id } })).toBe(1);
  }, testTimeout);

  it('S04 activation cannot issue a linked session after a concurrent suspension commits', async () => {
    const fixture = await googleFixture({ active: false });
    const subject = randomUUID();
    const user = await prisma.user.create({ data: { displayName: 'Synthetic Google' } });
    await prisma.oAuthIdentity.create({ data: { provider: 'google', providerSubject: subject, userId: user.id } });
    let pending;
    await createGoogleHandoff(redis, { subject, email: 'suspension@example.test', name: null }, fixture.intent, {
      cookie(name, value) { if (name === GOOGLE_HANDOFF_COOKIE) pending = name + '=' + value; },
    });
    const suspended = Promise.withResolvers();
    const userLockEntered = Promise.withResolvers();
    const real = prisma.$transaction.bind(prisma);
    const gated = {
      $queryRaw: prisma.$queryRaw.bind(prisma),
      authBrowserIntent: prisma.authBrowserIntent,
      $transaction: (operation, options) => real((tx) => operation({
        authBrowserIntent: tx.authBrowserIntent,
        oAuthIdentity: tx.oAuthIdentity,
        user: tx.user,
        $queryRaw: (parts, ...values) => {
          if (parts.join('').includes('FROM users WHERE')) userLockEntered.resolve();
          return tx.$queryRaw(parts, ...values);
        },
      }), options),
    };
    const suspend = real(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { status: 'suspended' } });
      suspended.resolve();
      await userLockEntered.promise;
    });
    await suspended.promise;
    const result = await request(createApp({ prisma: gated, settings, redisClient: redis }))
      .post('/api/v1/auth/refresh').set('Origin', origin).set('X-Acadboost-Google-Attempt', fixture.intent.actionId)
      .set('Cookie', fixture.binding + '; ' + pending);
    await suspend;
    expect(result.status).toBe(401);
    expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id } })).toBe(0);
    expect((await prisma.authBrowserIntent.findUnique({ where: { id: fixture.intent.id } })).tokenFamilyId).toBeNull();
  }, testTimeout);

  it.each([true, false])('S04 password reset and fenced rotation serialize with rotation first = %s', async (rotationFirst) => {
    const fixture = await googleFixture();
    const control = await prisma.user.create({ data: { displayName: 'Independent password-reset control' } });
    const other = await issueSession(prisma, settings, control, 'test', metadata);
    const resetToken = randomBytes(32).toString('base64url');
    const now = new Date();
    await prisma.passwordCredential.create({
      data: { userId: fixture.user.id, passwordHash: await hashPassword(password) },
    });
    await prisma.passwordResetToken.create({ data: {
      userId: fixture.user.id, tokenHash: createHash('sha256').update(resetToken).digest('hex'),
      createdAt: now, expiresAt: new Date(now.getTime() + 60_000),
    } });
    const firstInside = Promise.withResolvers();
    const secondEntered = Promise.withResolvers();
    const transaction = prisma.$transaction.bind(prisma);
    const gatedPrisma = (goesFirst) => ({
      $transaction: (operation) => transaction(async (tx) => {
        const gatedTx = {
          authSession: tx.authSession, user: tx.user, securityEvent: tx.securityEvent,
          passwordCredential: tx.passwordCredential, passwordResetToken: tx.passwordResetToken,
          $queryRaw: (...args) => {
            if (!goesFirst) secondEntered.resolve();
            return tx.$queryRaw(...args);
          },
        };
        const outcome = await operation(gatedTx);
        if (goesFirst) {
          firstInside.resolve();
          await secondEntered.promise;
        }
        return outcome;
      }, { timeout: 15_000 }),
    });
    const rotate = () => rotateRefresh(gatedPrisma(rotationFirst), settings, fixture.refresh, {
      headers: { origin, cookie: fixture.binding },
      get(name) { return this.headers[name.toLowerCase()]; },
    }).then(() => 200, (error) => error.status);
    const reset = () => request(createApp({ prisma: gatedPrisma(!rotationFirst), settings, redisClient: redis }))
      .post('/api/v1/auth/password/reset').send({ token: resetToken, password: password + '-changed' })
      .then((result) => result.status);
    const first = rotationFirst ? rotate() : reset();
    await firstInside.promise;
    const second = rotationFirst ? reset() : rotate();
    expect(await Promise.all([first, second])).toEqual(rotationFirst ? [200, 204] : [204, 401]);
    const family = await prisma.authSession.findMany({ where: { browserIntentId: fixture.intent.id } });
    expect(family).toHaveLength(rotationFirst ? 2 : 1);
    expect(family.every((row) => row.revokedAt)).toBe(true);
    expect((await me(other.access)).status).toBe(200);
  }, testTimeout);

  it('S08 requires explicit recovery after expiry and does not adopt the prior family', async () => {
    const fixture = await googleFixture();
    const now = Date.now();
    await prisma.authBrowserContext.update({ where: { id: fixture.context.id }, data: {
      createdAt: new Date(now - 120_000), expiresAt: new Date(now - 60_000),
    } });
    expect((await me(fixture.access, fixture.binding)).status).toBe(401);
    const reset = await app().post('/api/v1/auth/browser-context').set('Origin', origin)
      .set('X-Acadboost-Browser-Auth', '1').set('Cookie', fixture.binding).send({ reset: true });
    expect(reset.status).toBe(204);
    expect(reset.headers['set-cookie'][0]).toMatch(/^__Host-outpost_auth_context=;/);
    const boot = await app().post('/api/v1/auth/browser-context').set('Origin', origin)
      .set('X-Acadboost-Browser-Auth', '1').send({});
    expect(boot.status).toBe(200);
    expect(boot.body.context_id).not.toBe(fixture.context.id);
    const replacement = boot.headers['set-cookie'][0].split(';', 1)[0];
    expect((await me(fixture.access, replacement)).status).toBe(401);
    const old = await prisma.authBrowserContext.findUnique({ where: { id: fixture.context.id } });
    expect(old.retiredAt).toBeInstanceOf(Date);
    expect(old.bindingDigest).toBeNull();
    expect(await prisma.authBrowserIntent.findUnique({ where: { id: fixture.intent.id } })).toBeTruthy();
    await prisma.authBrowserContext.update({ where: { id: boot.body.context_id }, data: { generation: 9223372036854775807n } });
    expect((await action('logout', { binding: replacement })).status).toBe(409);
    const unchanged = await prisma.authBrowserContext.findUnique({ where: { id: boot.body.context_id } });
    expect(unchanged.generation).toBe(9223372036854775807n);
    expect(await prisma.authBrowserIntent.count({ where: { contextId: boot.body.context_id } })).toBe(0);
  }, testTimeout);

  it('X03 rejects an expired handoff and malformed JSON without generation movement', async () => {
    const fixture = await googleFixture({ active: false });
    let cookie;
    await createGoogleHandoff(redis, { subject: randomUUID(), email: 'expired@example.test', name: null }, fixture.intent, {
      cookie(name, value) { cookie = { name, value }; },
    });
    const key = 'outpost:google-handoff:v1:' + createHash('sha256').update(cookie.value).digest('hex');
    await redis.eval('return redis.call("PEXPIREAT", KEYS[1], 1)', { keys: [key], arguments: [] });
    const expired = await app().post('/api/v1/auth/refresh').set('Origin', origin)
      .set('X-Acadboost-Google-Attempt', fixture.intent.actionId)
      .set('Cookie', fixture.binding + '; ' + cookie.name + '=' + cookie.value);
    expect(expired.status).toBe(401);
    const malformed = await action('password/login', fixture).set('Content-Type', 'application/json').send('{');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('invalid_json');
    expect((await prisma.authBrowserContext.findUnique({ where: { id: fixture.context.id } })).generation).toBe(1n);
    expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id } })).toBe(0);
  }, testTimeout);

  it('X04 keeps fencing effective with Google disabled', async () => {
    const fixture = await googleFixture();
    const disabled = request(createApp({ prisma, settings: { ...settings, googleHandoffEnabled: false }, redisClient: redis }));
    expect((await disabled.get('/api/v1/auth/google/availability').set('Sec-Fetch-Site', 'same-origin')).status).toBe(503);
    const newer = await disabled.post('/api/v1/auth/password/login').set('Origin', origin)
      .set('X-Acadboost-Auth-Intent', randomUUID()).set('Cookie', fixture.binding)
      .send({ identifier: 'unknown@example.test', password });
    expect(newer.status).toBe(401);
    await assertFenced(fixture);
  }, testTimeout);

  it('X04 fails availability closed when PostgreSQL or Valkey is unavailable', async () => {
    app();
    const enabled = {
      ...settings, googleClientId: 'synthetic', googleClientSecret: 'synthetic',
      googleRedirectUri: origin + '/api/v1/auth/google/callback',
    };
    const failure = async () => { throw new Error('synthetic dependency failure'); };
    const postgresDown = request(createApp({ prisma: { $queryRaw: failure }, settings: enabled, redisClient: redis }));
    const valkeyDown = request(createApp({ prisma, settings: enabled, redisClient: { ping: failure } }));
    for (const server of [postgresDown, valkeyDown]) {
      const response = await server.get('/api/v1/auth/google/availability').set('Sec-Fetch-Site', 'same-origin');
      expect(response.status).toBe(503);
      expect(response.body.error.message).toBe('Google authentication is unavailable');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  }, testTimeout);

  it('S07 a restarted application and empty Valkey namespace cannot restore a PostgreSQL fence', async () => {
    const fixture = await googleFixture();
    expect((await action('logout', fixture)).status).toBe(204);
    const unfinished = await googleFixture({ active: false });
    let pending;
    await createGoogleHandoff(redis, { subject: randomUUID(), email: 'cache-loss@example.test', name: null }, unfinished.intent, {
      cookie(name, value) { if (name === GOOGLE_HANDOFF_COOKIE) pending = name + '=' + value; },
    });
    const newDatabase = createPrismaClient(url);
    const isolatedValkey = new URL(valkey);
    isolatedValkey.pathname = '/5';
    const newCache = createValkeyClient(isolatedValkey.href);
    try {
      const restarted = request(createApp({ prisma: newDatabase, settings, redisClient: newCache }));
      const refresh = await restarted.post('/api/v1/auth/refresh').set('Origin', origin)
        .set('Cookie', fixture.binding + '; outpost_refresh=' + fixture.refresh);
      expect(refresh.status).toBe(401);
      const access = await restarted.get('/api/v1/me').set('Cookie', fixture.binding)
        .set('Authorization', 'Bearer ' + fixture.access);
      expect(access.status).toBe(401);
      expect(await newDatabase.authSession.count({ where: { browserIntentId: fixture.intent.id, revokedAt: null } })).toBe(0);
      const lost = await restarted.post('/api/v1/auth/refresh').set('Origin', origin)
        .set('X-Acadboost-Google-Attempt', unfinished.intent.actionId).set('Cookie', unfinished.binding + '; ' + pending);
      expect(lost.status).toBe(401);
      expect(await newDatabase.authSession.count({ where: { browserIntentId: unfinished.intent.id } })).toBe(0);
    } finally {
      await newCache.close();
      await newDatabase.$disconnect();
    }
  }, testTimeout);

  it('S07 survives owned process termination after Google activation and a newer intent commit', async () => {
    const fixture = await googleFixture({ active: false });
    let grant;
    await createGoogleHandoff(redis, { subject: randomUUID(), email: 'process@example.test', name: null }, fixture.intent, {
      cookie(name, value) { if (name === GOOGLE_HANDOFF_COOKIE) grant = name + '=' + value; },
    });
    const before = new URL(valkey);
    before.pathname = '/4';
    const after = new URL(valkey);
    after.pathname = '/5';
    let first, second, third;
    try {
      first = await startAuthProcess(before.href);
      const issued = await first.api.post('/api/v1/auth/refresh').set('Origin', origin)
        .set('X-Acadboost-Google-Attempt', fixture.intent.actionId).set('Cookie', fixture.binding + '; ' + grant);
      expect(issued.status).toBe(200);
      const oldRefresh = issued.headers['set-cookie'].find((value) => value.startsWith('outpost_refresh=')).split(';', 1)[0];
      await first.stop();
      first = null;
      second = await startAuthProcess(after.href);
      const newer = await second.api.post('/api/v1/auth/password/login').set('Origin', origin)
        .set('X-Acadboost-Auth-Intent', randomUUID()).set('Cookie', fixture.binding)
        .send({ identifier: 'unknown@example.test', password });
      expect(newer.status).toBe(401);
      await second.stop();
      second = null;
      third = await startAuthProcess(after.href);
      const replay = await third.api.post('/api/v1/auth/refresh').set('Origin', origin)
        .set('Cookie', fixture.binding + '; ' + oldRefresh);
      expect(replay.status).toBe(401);
      const bearer = await third.api.get('/api/v1/me').set('Cookie', fixture.binding)
        .set('Authorization', 'Bearer ' + issued.body.access_token);
      expect(bearer.status).toBe(401);
      const receipt = await prisma.authBrowserIntent.findUnique({ where: { id: fixture.intent.id } });
      expect(receipt.supersededAt).toBeInstanceOf(Date);
      expect(await prisma.authSession.count({ where: { browserIntentId: fixture.intent.id, revokedAt: null } })).toBe(0);
    } finally {
      await first?.stop();
      await second?.stop();
      await third?.stop();
    }
  }, testTimeout);
});
