import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { issueAccessToken } from '../src/modules/auth/tokens.js';

const settings = { authSigningKey: 'migration-test-signing-key-which-is-at-least-32-bytes' };
const registration = {
  display_name: 'Migration Student', username: 'migration_student',
  email: 'migration.student@example.com', password: 'a-long-password-2026',
  account_type: 'student',
};

function fakePrisma() {
  const users = new Map();
  const credentials = new Map();
  const sessions = new Map();
  const events = [];
  const prisma = {
    user: {
      create: vi.fn(async ({ data }) => {
        const user = {
          id: randomUUID(), status: 'active', displayName: data.displayName,
          username: data.username, primaryEmail: data.primaryEmail,
          accountType: data.accountType, emailVerifiedAt: null,
        };
        users.set(user.id, user);
        return user;
      }),
      findFirst: vi.fn(async ({ where }) => {
        const user = [...users.values()].find((item) =>
          where.username?.equals === item.username || where.primaryEmail?.equals === item.primaryEmail);
        return user ? { ...user, passwordCredential: credentials.get(user.id) } : null;
      }),
      findUnique: vi.fn(async ({ where }) => users.get(where.id) ?? null),
    },
    passwordCredential: { create: vi.fn(async ({ data }) => {
      credentials.set(data.userId, { passwordHash: data.passwordHash });
    }) },
    authSession: {
      create: vi.fn(async ({ data }) => {
        const session = { ...data, revokedAt: null, replacedBySessionId: null };
        sessions.set(session.id, session);
        return session;
      }),
      findUnique: vi.fn(async ({ where }) =>
        [...sessions.values()].find((item) => item.id === where.id || item.refreshTokenHash === where.refreshTokenHash) ?? null),
      findMany: vi.fn(async () => [...sessions.values()]),
    },
    securityEvent: { create: vi.fn(async ({ data }) => events.push(data)) },
    $transaction: async (callback) => callback(prisma),
    $queryRaw: async () => [{ id: 'ok' }],
  };
  return { prisma, users, credentials, sessions, events };
}

describe('password registration to authenticated dashboard', () => {
  it('registers, rejects invalid input, signs in, and retrieves the same user', async () => {
    const db = fakePrisma();
    const app = createApp({ prisma: db.prisma, settings });
    const invalid = await request(app).post('/api/v1/auth/password/register').send({ ...registration, password: 'short' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('validation_error');
    const created = await request(app).post('/api/v1/auth/password/register').send(registration);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      display_name: registration.display_name, username: registration.username,
      primary_email: registration.email, account_type: 'student',
    });
    expect(created.body).not.toHaveProperty('password');
    expect(db.credentials.size).toBe(1);

    const signedIn = await request(app).post('/api/v1/auth/password/login').send({
      identifier: registration.email.toUpperCase(), password: registration.password,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ token_type: 'bearer', expires_in: 900 });
    expect(signedIn.headers['set-cookie'][0]).toContain('outpost_refresh=');
    expect(signedIn.headers['set-cookie'][0]).toContain('HttpOnly');
    const me = await request(app).get('/api/v1/me')
      .set('Authorization', `Bearer ${signedIn.body.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(created.body.id);
    expect(db.events[0].eventType).toBe('authentication.succeeded');

    const denied = await request(app).post('/api/v1/auth/password/login').send({
      identifier: registration.email, password: 'incorrect-synthetic-password',
    });
    expect(denied.status).toBe(401);
    expect(denied.body.error).toEqual({
      code: 'unauthorized', message: 'Invalid credentials', request_id: denied.headers['x-request-id'],
    });
    expect(denied.headers['set-cookie']).toBeUndefined();
    expect(db.sessions.size).toBe(1);
  }, 20000);

  it('rejects a token for a session that has been revoked', async () => {
    const db = fakePrisma();
    const user = await db.prisma.user.create({ data: {
      displayName: 'Test', username: 'test_user', primaryEmail: 'test@example.com', accountType: 'student',
    } });
    const sessionId = randomUUID();
    db.sessions.set(sessionId, {
      id: sessionId, userId: user.id, revokedAt: new Date(), expiresAt: new Date(Date.now() + 60000),
    });
    const token = await issueAccessToken(settings, user.id, sessionId);
    const response = await request(createApp({ prisma: db.prisma, settings }))
      .get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(401);
  });
});
