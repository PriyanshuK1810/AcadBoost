import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/core/errors.js';
import { registerLearningRoutes } from '../src/modules/learning/routes.js';

const org = '11111111-1111-4111-8111-111111111111';
const cohort = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const user = { id: member, account_type: 'coordinator' };

function app(role) {
  const server = express();
  const prisma = {
    organization: { findUnique: async () => ({ id: org, status: 'active' }) },
    organizationMembership: { findFirst: async () => ({ id: member, role, status: 'active' }) },
    user: { findUnique: async () => ({ id: member, status: 'active', accountType: 'coordinator' }) },
    authSession: { findUnique: async () => ({ userId: member, expiresAt: new Date(Date.now() + 60_000) }) },
    mentorCohortAssignment: { findMany: async () => [] },
    $queryRaw: async () => [],
    async $transaction(work) { return work(this); },
  };
  registerLearningRoutes(server, {
    prisma,
    requireUser(req, _res, next) { req.user = user; req.authSession = { id: member }; next(); },
  });
  server.use(errorHandler);
  return request(server);
}

describe('Mentor route authorization', () => {
  it('lists an empty assignment scope for an active Mentor', async () => {
    const response = await app('mentor').get('/api/v1/organizations/' + org + '/mentor/cohorts');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it.each(['admin', 'coordinator', 'mentor', 'student'])('rejects assignment by %s', async (role) => {
    const response = await app(role).put('/api/v1/organizations/' + org + '/cohorts/' + cohort + '/mentor-assignments/' + member);
    expect(response.status).toBe(403);
  });
});
