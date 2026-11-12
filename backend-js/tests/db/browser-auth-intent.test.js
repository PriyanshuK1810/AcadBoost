import { createHash } from 'node:crypto';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';
import { createPrismaClient } from '../../src/db/client.js';
import {
  BROWSER_CONTEXT_COOKIE,
  contextProofDigest,
  hasBrowserContext,
  validateBrowserRequest,
  browserActionId,
  advanceBrowserIntent,
  findCurrentGoogleReceipt,
  lockUserRows,
  lockBrowserContext,
} from '../../src/modules/auth/browserIntents.js';
import { createSession, rotateRefresh } from '../../src/modules/auth/service.js';

const settings = { publicAppOrigin: 'https://app.example.test' };
const req = (cookie, headers = {}) => ({ headers: { cookie, origin: settings.publicAppOrigin, 'x-acadboost-browser-auth': '1', 'content-type': 'application/json', ...headers } });

describe('browser intent request boundary', () => {
  test('hashes exactly one context proof and refuses duplicate proof cookies', () => {
    const token = Buffer.alloc(32, 7).toString('base64url');
    const request = req(`${BROWSER_CONTEXT_COOKIE}=${token}`);
    expect(contextProofDigest(request)).toEqual(createHash('sha256').update(Buffer.from(token, 'base64url')).digest());
    expect(hasBrowserContext(request)).toBe(true);
    const duplicate = req(`${BROWSER_CONTEXT_COOKIE}=${token}; ${BROWSER_CONTEXT_COOKIE}=${token}`);
    expect(hasBrowserContext(duplicate)).toBe(true);
    expect(contextProofDigest(duplicate)).toBeNull();
  });

  test('guards exact Origin and rejects duplicate guarded headers', () => {
    const valid = req('');
    expect(validateBrowserRequest(valid, settings, 'x-acadboost-browser-auth')).toBe(true);
    expect(validateBrowserRequest(req('', { origin: 'null' }), settings, 'x-acadboost-browser-auth')).toBe(false);
    expect(validateBrowserRequest(req('', { origin: `${settings.publicAppOrigin}, ${settings.publicAppOrigin}` }), settings, 'x-acadboost-browser-auth')).toBe(false);
    expect(validateBrowserRequest(req('', { 'x-acadboost-browser-auth': '1, 1' }), settings, 'x-acadboost-browser-auth')).toBe(false);
  });

  test('accepts only a single v4 action UUID', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const bound = { headers: { cookie: `${BROWSER_CONTEXT_COOKIE}=${Buffer.alloc(32, 7).toString('base64url')}`, origin: settings.publicAppOrigin, 'x-acadboost-auth-intent': id } };
    expect(browserActionId(bound, settings)).toBe(id);
    expect(() => browserActionId({ ...bound, headers: { ...bound.headers, 'x-acadboost-auth-intent': `${id}, ${id}` } }, settings)).toThrow();
    expect(() => browserActionId({ ...bound, headers: { ...bound.headers, origin: 'null' } }, settings)).toThrow();
    expect(() => browserActionId({ ...bound, headers: { ...bound.headers, cookie: `${BROWSER_CONTEXT_COOKIE}=bad` } }, settings)).toThrow();
  });
});

const databaseUrl = process.env.M01B_R1_DATABASE_URL;
describe.skipIf(!databaseUrl)('browser auth intent PostgreSQL contract', () => {
  let prisma;
  let monitor;
  let appName;
  let context;
  const contexts = [];
  const testUsers = [];
  const origin = 'https://app.r1.test';
  const settings = { publicAppOrigin: origin, authSigningKey: randomBytes(48).toString('base64url') };
  const sessionRequest = proof => ({
    headers: { cookie: `${BROWSER_CONTEXT_COOKIE}=${proof}`, origin },
    get(name) { return name.toLowerCase() === 'origin' ? origin : name.toLowerCase() === 'user-agent' ? 'R1 database fixture' : undefined; },
  });
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!/^\/outpost_m01b_r1_[a-z0-9_]+$/.test(url.pathname) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.port !== '5433') {
      throw new Error('Requires a newly provisioned loopback outpost_m01b_r1_* database');
    }
    appName = `m01br1_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    url.searchParams.set('application_name', appName);
    prisma = createPrismaClient(url.href);
    monitor = new pg.Client({ connectionString: url.href });
    await monitor.connect();
    context = await createContext();
  });
  afterAll(async () => {
    if (!prisma) return;
    for (const candidate of contexts) {
      await prisma.authSession.deleteMany({ where: { browserIntent: { contextId: candidate.id } } });
      await prisma.authBrowserIntent.deleteMany({ where: { contextId: candidate.id } });
      await prisma.authBrowserContext.deleteMany({ where: { id: candidate.id } });
    }
    for (const id of testUsers) await prisma.user.deleteMany({ where: { id } });
    await monitor?.end();
    await prisma.$disconnect();
  });

  async function createContext(proof) {
    const row = await prisma.authBrowserContext.create({ data: {
      bindingDigest: proof
        ? createHash('sha256').update(Buffer.from(proof, 'base64url')).digest()
        : randomBytes(32),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    } });
    contexts.push(row);
    return row;
  }
  async function activeGoogleSession() {
    const user = await prisma.user.create({ data: { displayName: 'R1 fenced family fixture' } });
    testUsers.push(user.id);
    const proof = randomBytes(32).toString('base64url');
    const context = await createContext(proof);
    const request = sessionRequest(proof);
    const familyId = randomUUID();
    const session = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM auth_browser_contexts WHERE id = ${context.id} FOR UPDATE`;
      let locked = await tx.authBrowserContext.findUnique({ where: { id: context.id } });
      const { intent } = await advanceBrowserIntent(tx, locked, { actionId: randomUUID(), kind: 'google' });
      const activatedAt = new Date();
      await tx.authBrowserIntent.update({ where: { id: intent.id }, data: {
        claimedAt: activatedAt, tokenFamilyId: familyId, sessionUserId: user.id, activatedAt,
      } });
      locked = await tx.authBrowserContext.findUnique({ where: { id: context.id } });
      await lockUserRows(tx, [user.id]);
      return createSession(tx, settings, user, 'google', request, {
        intentId: intent.id, tokenFamilyId: familyId, expiresAt: locked.expiresAt,
      });
    });
    return { context, user, proof, request, familyId, refresh: session.refresh };
  }
  async function fenceFamily(family, actionId = randomUUID()) {
    return prisma.$transaction(async tx => {
      const locked = await lockBrowserContext(tx, family.request, settings);
      const receipt = await findCurrentGoogleReceipt(tx, locked);
      await lockUserRows(tx, receipt ? [receipt.sessionUserId] : []);
      return advanceBrowserIntent(tx, locked, { actionId, kind: 'password' });
    });
  }
  async function waitForObservedUserLock() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await monitor.query(`SELECT pid, query FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock' AND query ILIKE '%users%'`, [appName]);
      if (result.rowCount) return result.rows[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting to observe the browser fence blocked on the refresh user lock');
  }

  test('commits one generation per action and leaves Google intent unclaimed', async () => {
    const googleAction = randomUUID();
    const passwordAction = randomUUID();
    const acceptedGoogle = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM auth_browser_contexts WHERE id = ${context.id} FOR UPDATE`;
      const locked = await tx.authBrowserContext.findUnique({ where: { id: context.id } });
      return advanceBrowserIntent(tx, locked, { actionId: googleAction, kind: 'google' });
    });
    expect(acceptedGoogle.duplicate).toBe(false);
    expect(acceptedGoogle.intent.claimedAt).toBeNull();
    const duplicate = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM auth_browser_contexts WHERE id = ${context.id} FOR UPDATE`;
      const locked = await tx.authBrowserContext.findUnique({ where: { id: context.id } });
      return advanceBrowserIntent(tx, locked, { actionId: googleAction, kind: 'google' });
    });
    expect(duplicate.duplicate).toBe(true);
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM auth_browser_contexts WHERE id = ${context.id} FOR UPDATE`;
      const locked = await tx.authBrowserContext.findUnique({ where: { id: context.id } });
      await advanceBrowserIntent(tx, locked, { actionId: passwordAction, kind: 'password' });
    });
    const current = await prisma.authBrowserContext.findUnique({ where: { id: context.id } });
    expect(current.generation).toBe(2n);
    expect(await prisma.authBrowserIntent.count({ where: { contextId: context.id } })).toBe(2);
  });

  test('composite session receipt foreign key rejects a different owner', async () => {
    const owner = await prisma.user.create({ data: { displayName: 'R1 fixture owner' } });
    const other = await prisma.user.create({ data: { displayName: 'R1 fixture other' } });
    testUsers.push(owner.id, other.id);
    const now = new Date();
    const receipt = await prisma.authBrowserIntent.create({ data: {
      contextId: context.id, actionId: randomUUID(), kind: 'google', generation: 3n,
      acceptedAt: now, claimedAt: now, redeemUntil: new Date(now.getTime() + 60_000),
      tokenFamilyId: randomUUID(), sessionUserId: owner.id, activatedAt: now,
    } });
    await expect(prisma.authSession.create({ data: {
      userId: other.id, tokenFamilyId: receipt.tokenFamilyId, browserIntentId: receipt.id,
      refreshTokenHash: `r1-fixture-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000),
    } })).rejects.toMatchObject({ code: 'P2003' });
  });

  test('S01: a refresh successor committed first is revoked when the newer intent takes the user lock', async () => {
    const family = await activeGoogleSession();
    let releaseRotation;
    let announceRotation;
    const rotationEntered = new Promise(resolve => { announceRotation = resolve; });
    const rotationGate = new Promise(resolve => { releaseRotation = resolve; });
    const gatedPrisma = {
      $transaction: (callback, options) => prisma.$transaction(async tx => {
        const result = await callback(tx);
        announceRotation();
        await rotationGate;
        return result;
      }, options),
    };
    const rotation = rotateRefresh(gatedPrisma, settings, family.refresh, family.request);
    await rotationEntered;
    const fencing = fenceFamily(family);
    const observed = await waitForObservedUserLock();
    expect(observed.query.toLowerCase()).toContain('users');
    releaseRotation();
    const successor = await rotation;
    await fencing;
    const rows = await prisma.authSession.findMany({ where: { tokenFamilyId: family.familyId } });
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.browserIntentId === rows[0].browserIntentId && row.revokedAt !== null)).toBe(true);
    await expect(rotateRefresh(prisma, settings, successor.refresh, family.request)).rejects.toMatchObject({ status: 401 });
  }, 20_000);

  test('S02: a committed fence rejects the original refresh without inserting a successor', async () => {
    const family = await activeGoogleSession();
    await fenceFamily(family);
    await expect(rotateRefresh(prisma, settings, family.refresh, family.request)).rejects.toMatchObject({ status: 401 });
    const rows = await prisma.authSession.findMany({ where: { tokenFamilyId: family.familyId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].replacedBySessionId).toBeNull();
  });
});
