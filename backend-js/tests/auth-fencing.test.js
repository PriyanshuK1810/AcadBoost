import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createRequireUser, rotateRefresh } from '../src/modules/auth/service.js';
import { issueAccessToken } from '../src/modules/auth/tokens.js';

const origin = 'https://app.example.test';
const settings = {
  env: 'test',
  publicAppOrigin: origin,
  authSigningKey: 'synthetic-signing-key-for-intent-fence-tests',
};
const proof = randomBytes(32).toString('base64url');
const binding = '__Host-outpost_auth_context=' + proof;

function fencedFixture() {
  const user = { id: randomUUID(), status: 'active', displayName: 'Synthetic', accountType: 'student' };
  const session = {
    id: randomUUID(), userId: user.id, browserIntentId: randomUUID(), tokenFamilyId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000), revokedAt: null, replacedBySessionId: null,
  };
  const db = {
    user: { findUnique: vi.fn(async () => user), findFirst: vi.fn(async () => null) },
    authSession: {
      findUnique: vi.fn(async () => session),
      create: vi.fn(async ({ data }) => data),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    securityEvent: { create: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (action) => action(db)),
  };
  return { user, session, db };
}

function fencedRequest(authorization) {
  return {
    headers: { cookie: binding, origin },
    cookies: { '__Host-outpost_auth_context': proof },
    get(name) {
      if (name.toLowerCase() === 'authorization') return authorization;
      return this.headers[name.toLowerCase()];
    },
  };
}

describe('fenced session authorization', () => {
  it('denies an unrevoked row when the authoritative fenced-session lookup has no eligible receipt', async () => {
    const { user, session, db } = fencedFixture();
    const token = await issueAccessToken(settings, user.id, session.id);
    const next = vi.fn();
    await createRequireUser(db, settings)(fencedRequest('Bearer ' + token), null, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it('denies refresh after locking the user when the receipt is superseded', async () => {
    const { db } = fencedFixture();
    const status = await rotateRefresh(db, settings, 'synthetic-refresh', fencedRequest())
      .then(() => 200, (error) => error.status);
    expect(status).toBe(401);
    expect(db.authSession.create).not.toHaveBeenCalled();
  });

  it('rejects a foreign-origin bound password submission before verifying credentials', async () => {
    const { db } = fencedFixture();
    const response = await request(createApp({ prisma: db, settings })).post('/api/v1/auth/password/login')
      .set('Origin', 'https://foreign.example.test')
      .set('Cookie', binding)
      .set('X-Acadboost-Auth-Intent', randomUUID())
      .send({ identifier: 'synthetic@example.test', password: 'synthetic-password' });
    expect(response.status).toBe(403);
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a foreign-origin bound phone submission before checking the challenge', async () => {
    const { db } = fencedFixture();
    db.otpChallenge = { findFirst: vi.fn(async () => null) };
    const response = await request(createApp({ prisma: db, settings })).post('/api/v1/auth/phone/verify')
      .set('Origin', 'https://foreign.example.test')
      .set('Cookie', binding)
      .set('X-Acadboost-Auth-Intent', randomUUID())
      .send({ phone: '+14155552671', code: '123456' });
    expect(response.status).toBe(403);
    expect(db.otpChallenge.findFirst).not.toHaveBeenCalled();
  });
});
