import { publishRoadmap } from '../helpers/roadmapWorkflow.js';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/core/errors.js';
import { registerLearningRoutes } from '../../src/modules/learning/routes.js';

function fixture() {
  const calls = [];
  const prisma = {
    $transaction: async (fn) => fn(prisma),
    organization: {
      create: async ({ data }) => {
        calls.push(['organization.create', data]);
        return { id: '11111111-1111-4111-8111-111111111111', status: 'active', ...data };
      },
      findUnique: async () => null,
    },
    organizationMembership: {
      create: async ({ data }) => { calls.push(['membership.create', data]); },
      findFirst: async () => null,
    },
    cohort: { findFirst: async () => null },
  };
  const app = express();
  app.use(express.json());
  const requireUser = (req, _res, next) => {
    req.user = { id: req.get('X-Test-User') || '22222222-2222-4222-8222-222222222222', account_type: req.get('X-Test-Role') || 'student', display_name: 'Learner' };
    next();
  };
  registerLearningRoutes(app, { prisma, settings: {}, requireUser, redisClient: { eval: async () => 1 } });
  app.use(errorHandler);
  return { app, calls };
}

describe('live learning route guardrails', () => {
  it('allows a coordinator to create an organization and makes membership atomic', async () => {
    const { app, calls } = fixture();
    const denied = await request(app).post('/api/v1/organizations').send({ name: 'Campus' });
    expect(denied.status).toBe(403);
    const created = await request(app).post('/api/v1/organizations').set('X-Test-Role', 'coordinator').send({ name: '  Campus  ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: '11111111-1111-4111-8111-111111111111', name: 'Campus', role: 'owner' });
    expect(calls.map(([name]) => name)).toEqual(['organization.create', 'membership.create']);
    expect(calls[1][1]).toMatchObject({ organizationId: created.body.id, role: 'owner' });
  });

  it('requires active ownership and validates input before creating a roadmap', async () => {
    const { app } = fixture();
    const org = '11111111-1111-4111-8111-111111111111';
    expect((await request(app).post('/api/v1/organizations/' + org + '/roadmaps').set('X-Test-Role', 'coordinator').send({ name: 'Plan', topics: [{ title: 'Topic' }] })).status).toBe(403);
    expect((await request(app).post('/api/v1/organizations').set('X-Test-Role', 'coordinator').send({ name: 'X' })).status).toBe(422);
    expect((await request(app).post('/api/v1/cohorts/join').send({ invite_code: 'x'.repeat(24) })).status).toBe(404);
  });
});

function workflowFixture({ redisClient } = {}) {
  let sequence = 1;
  const makeId = () => '00000000-0000-4000-8000-' + String(sequence++).padStart(12, '0');
  const tables = Object.fromEntries(
    ['organization', 'organizationMembership', 'organizationInvitation', 'roadmap', 'roadmapVersion', 'phase', 'week', 'topic', 'cohort', 'cohortEnrollment', 'topicProgress', 'activityEvent', 'user', 'roadmapReviewAttempt', 'auditEvent']
      .map((name) => [name, []]),
  );
  tables.user.push(
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Coordinator', primaryEmail: 'owner@example.edu', emailVerifiedAt: new Date(), accountType: 'coordinator', status: 'active' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'Learner', primaryEmail: 'student@example.edu', accountType: 'student', status: 'active' },
  );
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === 'cohortId_userId') return row.cohortId === value.cohortId && row.userId === value.userId;
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && 'gt' in value) return row[key] > value.gt;
    return row[key] === value;
  });
  const model = (name) => ({
    create: async ({ data }) => {
      const row = { id: makeId(), createdAt: new Date('2026-09-25T00:00:00Z'), status: 'active', revision: 1,
        ...(name === 'roadmapReviewAttempt' ? { decision: 'pending', submittedAt: new Date(), reviewedAt: null, rejectionReason: null } : {}), ...data };
      tables[name].push(row);
      return row;
    },
    createMany: async ({ data }) => {
      for (const entry of data) {
        const keys = name === 'cohortEnrollment' ? ['cohortId', 'userId'] : ['organizationId', 'userId'];
        if (!tables[name].some((row) => keys.every((key) => row[key] === entry[key])))
          tables[name].push({ id: makeId(), status: 'active', ...entry });
      }
    },
    findMany: async ({ where = {} } = {}) => tables[name].filter((row) => matches(row, where)),
    findFirst: async ({ where }) => tables[name].find((row) => matches(row, where)) ?? null,
    findUnique: async ({ where }) => tables[name].find((row) => matches(row, where)) ?? null,
    update: async ({ where, data }) => {
      const row = tables[name].find((entry) => matches(entry, where));
      if (!row) throw new Error('Missing row');
      if (name === 'roadmapVersion' && data.status && data.status !== row.status) row.revision++;
      Object.assign(row, data);
      return row;
    },
    count: async ({ where }) => tables[name].filter((row) => matches(row, where)).length,
    groupBy: async ({ by, where }) => {
      const counts = new Map();
      for (const row of tables[name].filter((entry) => matches(entry, where)))
        counts.set(row[by[0]], (counts.get(row[by[0]]) ?? 0) + 1);
      return [...counts].map(([key, count]) => ({ [by[0]]: key, _count: { _all: count } }));
    },
    upsert: async ({ where, create, update }) => {
      const key = where.userId_topicId;
      const existing = tables[name].find((row) => matches(row, key));
      if (existing) Object.assign(existing, update);
      else tables[name].push({ id: makeId(), updatedAt: new Date('2026-09-25T00:00:00Z'), ...create });
    },
    deleteMany: async ({ where }) => {
      tables[name] = tables[name].filter((row) => !matches(row, where));
    },
  });
  const prisma = Object.fromEntries(Object.keys(tables).map((name) => [name, model(name)]));
  prisma.$transaction = async (fn) => fn(prisma);
  prisma.$queryRaw = async () => [{ id: 'locked' }];
  // Unit-only adapter for the real workflow SQL; security/integrity use PostgreSQL tests.
  prisma.$executeRaw = async (strings, ...values) => {
    const sql = strings.join('?');
    if (sql.includes('UPDATE roadmap_review_attempts')) {
      const [decision, reviewedBy, rejectionReason, id] = values;
      Object.assign(tables.roadmapReviewAttempt.find(row => row.id === id), { decision, reviewedBy, rejectionReason, reviewedAt: new Date() });
    } else if (sql.includes('UPDATE roadmap_versions')) {
      const [attemptId, id] = values;
      const row = tables.roadmapVersion.find(row => row.id === id);
      row.status = 'published'; row.revision++; row.publishedAt = tables.roadmapReviewAttempt.find(row => row.id === attemptId).reviewedAt;
    }
    return 1;
  };
  const rateCounts = new Map();
  const limiter = redisClient ?? {
    async eval(_script, { keys }) {
      const count = (rateCounts.get(keys[0]) ?? 0) + 1;
      rateCounts.set(keys[0], count);
      return count;
    },
  };
  const app = express();
  app.use(express.json());
  const requireUser = (req, _res, next) => {
    req.user = {
      id: req.get('X-Test-User') || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account_type: req.get('X-Test-Role') || 'coordinator',
      display_name: req.get('X-Test-Name') || 'Coordinator',
    };
    next();
  };
  registerLearningRoutes(app, { prisma, settings: {}, requireUser, redisClient: limiter });
  app.use(errorHandler);
  return { app, tables };
}

describe('live learning workflow', () => {
  it('creates an owned roadmap and cohort, joins a student, and reports completion', async () => {
    const { app, tables } = workflowFixture();
    const coordinator = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const student = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const org = await request(app).post('/api/v1/organizations').set(coordinator).send({ name: 'Campus' });
    expect(org.status).toBe(201);
    expect((await request(app).get('/api/v1/organizations').set(coordinator)).body).toMatchObject([{ id: org.body.id, role: 'owner' }]);
    const roadmap = await request(app)
      .post('/api/v1/organizations/' + org.body.id + '/roadmaps')
      .set(coordinator)
      .send({ name: 'Career readiness', topics: [{ title: 'Set goals' }, { title: 'Build portfolio' }] });
    expect(roadmap.status).toBe(201);
    expect(roadmap.body.status).toBe('draft');
    expect(roadmap.body.topics.map((topic) => topic.week)).toEqual([1, 2]);
    expect((await request(app).get('/api/v1/organizations/' + org.body.id + '/roadmaps').set(coordinator)).body).toHaveLength(1);
    expect((await publishRoadmap(app, roadmap.body.version_id, coordinator)).status).toBe(200);
    const cohort = await request(app)
      .post('/api/v1/organizations/' + org.body.id + '/cohorts')
      .set(coordinator)
      .send({ name: '2026 cohort', roadmap_version_id: roadmap.body.version_id });
    expect(cohort.status).toBe(201);
    expect(cohort.body.invite_code.length).toBeGreaterThanOrEqual(20);
    expect(cohort.body.invite_code).toHaveLength(43);
    const storedCohort = tables.cohort[0];
    expect(storedCohort.inviteCodeHash).not.toBe(cohort.body.invite_code);
    expect(storedCohort.inviteCode).toBeUndefined();
    expect(storedCohort.inviteCodeExpiresAt).toBeInstanceOf(Date);
    const listedCohorts = await request(app).get('/api/v1/organizations/' + org.body.id + '/cohorts').set(coordinator);
    expect(listedCohorts.body).toHaveLength(1);
    expect(listedCohorts.body[0]).toMatchObject({ join_code_status: 'active' });
    expect(listedCohorts.body[0]).not.toHaveProperty('invite_code');
    expect((await request(app).post('/api/v1/cohorts/join').set(coordinator).send({ invite_code: cohort.body.invite_code })).status).toBe(403);
    const joined = await request(app).post('/api/v1/cohorts/join').set(student).send({ invite_code: cohort.body.invite_code });
    expect(joined.status).toBe(200);
    expect(joined.body.cohort_id).toBe(cohort.body.id);
    expect((await request(app).post('/api/v1/cohorts/join').set(student).send({ invite_code: cohort.body.invite_code })).status).toBe(200);
    const before = await request(app).get('/api/v1/progress/me').set(student);
    expect(before.body[0]).toMatchObject({ completed: 0, total: 2 });
    const topicId = roadmap.body.topics[0].id;
    expect((await request(app).put('/api/v1/progress/topics/' + topicId).set(student).send({ completed: true })).status).toBe(204);
    const after = await request(app).get('/api/v1/progress/me').set(student);
    expect(after.body[0]).toMatchObject({ completed: 1, total: 2, percent: 50 });
    const report = await request(app).get('/api/v1/cohorts/' + cohort.body.id + '/progress').set(coordinator);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ average_percent: 50, students: [{ completed: 1, total: 2 }] });
    expect((await request(app).get('/api/v1/cohorts/' + cohort.body.id + '/progress').set(student)).status).toBe(403);
    expect((await request(app).put('/api/v1/progress/topics/' + topicId).set(student).send({ completed: false })).status).toBe(204);
    expect((await request(app).get('/api/v1/progress/me').set(student)).body[0].completed).toBe(0);
  });

  it('revokes learning access when an organization membership becomes inactive', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const learner = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const roadmap = await request(app).post(`/api/v1/organizations/${organization.body.id}/roadmaps`).set(owner)
      .send({ name: 'Plan', topics: [{ title: 'Topic' }] });
    await publishRoadmap(app, roadmap.body.version_id, owner);
    const cohort = await request(app).post(`/api/v1/organizations/${organization.body.id}/cohorts`).set(owner)
      .send({ name: 'Cohort', roadmap_version_id: roadmap.body.version_id });
    await request(app).post('/api/v1/cohorts/join').set(learner).send({ invite_code: cohort.body.invite_code });
    const member = tables.organizationMembership.find((row) => row.userId === learner['X-Test-User']);
    expect((await request(app).delete(`/api/v1/organizations/${organization.body.id}/members/${member.id}`)
      .set(owner)).status).toBe(204);
    expect((await request(app).get('/api/v1/progress/me').set(learner)).body).toEqual([]);
    expect((await request(app).put(`/api/v1/progress/topics/${roadmap.body.topics[0].id}`).set(learner)
      .send({ completed: true })).status).toBe(404);
    expect((await request(app).post('/api/v1/cohorts/join').set(learner)
      .send({ invite_code: cohort.body.invite_code })).status).toBe(403);
    expect((await request(app).get(`/api/v1/cohorts/${cohort.body.id}/progress`).set(owner)).body.students).toEqual([]);
  });

  it('rotates and revokes a one-time code and uses one response for invalid codes', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const student = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const roadmap = await request(app).post(`/api/v1/organizations/${organization.body.id}/roadmaps`).set(owner)
      .send({ name: 'Plan', topics: [{ title: 'Topic' }] });
    await publishRoadmap(app, roadmap.body.version_id, owner);
    const cohort = await request(app).post(`/api/v1/organizations/${organization.body.id}/cohorts`).set(owner)
      .send({ name: 'Cohort', roadmap_version_id: roadmap.body.version_id });
    tables.cohort[0].inviteCodeExpiresAt = new Date(Date.now() - 1);
    const expired = await request(app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: cohort.body.invite_code });
    expect(expired.status).toBe(404);
    expect(expired.body.error.message).toBe('Cohort invite not found');
    expect((await request(app).get(`/api/v1/organizations/${organization.body.id}/cohorts`).set(owner))
      .body[0].join_code_status).toBe('expired');
    const rotated = await request(app).post(`/api/v1/cohorts/${cohort.body.id}/join-code/rotate`).set(owner);
    expect(rotated.status).toBe(200);
    expect(rotated.body.invite_code).toHaveLength(43);
    expect(rotated.body.invite_code).not.toBe(cohort.body.invite_code);
    expect((await request(app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: cohort.body.invite_code })).status).toBe(404);
    expect((await request(app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: rotated.body.invite_code })).status).toBe(200);
    const invalid = await request(app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: 'x'.repeat(43) });
    expect(invalid.status).toBe(404);
    expect(invalid.body.error).toMatchObject({ code: 'not_found', message: 'Cohort invite not found' });
    expect((await request(app).delete(`/api/v1/cohorts/${cohort.body.id}/join-code`).set(owner)).status).toBe(204);
    expect((await request(app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: rotated.body.invite_code })).status).toBe(404);
    const list = await request(app).get(`/api/v1/organizations/${organization.body.id}/cohorts`).set(owner);
    expect(list.body[0]).toMatchObject({ join_code_status: 'revoked', invite_code_expires_at: null });
  });

  it('rate limits join attempts per IP and account and fails closed when Valkey is unavailable', async () => {
    const calls = [];
    const limited = workflowFixture({ redisClient: { async eval(_script, options) {
      calls.push({ key: options.keys[0], window: options.arguments[0] });
      const [key] = options.keys;
      return key.includes(':ip:') ? 31 : 1;
    } } });
    const student = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const limitedResult = await request(limited.app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: 'secret-code-'.padEnd(43, 'x') });
    expect(limitedResult.status).toBe(429);
    expect(limitedResult.headers['retry-after']).toBe('900');
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toMatch(/^outpost:cohort-join:ip:[0-9a-f]{64}$/);
    expect(calls[0].key).not.toContain(student['X-Test-User']);
    expect(calls[0].key).not.toContain('secret-code');
    expect(calls[0].window).toBe('900');

    const accountLimitedCalls = [];
    const accountLimited = workflowFixture({ redisClient: { async eval(_script, { keys }) {
      accountLimitedCalls.push(keys[0]);
      return keys[0].includes(':account:') ? 11 : 1;
    } } });
    const accountLimitedResult = await request(accountLimited.app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: 'another-secret-'.padEnd(43, 'y') });
    expect(accountLimitedResult.status).toBe(429);
    expect(accountLimitedCalls).toHaveLength(2);
    expect(accountLimitedCalls[1]).not.toContain(student['X-Test-User']);

    const unavailable = workflowFixture({ redisClient: { async eval() { throw new Error('Valkey unavailable'); } } });
    const unavailableResult = await request(unavailable.app).post('/api/v1/cohorts/join').set(student)
      .send({ invite_code: 'x'.repeat(43) });
    expect(unavailableResult.status).toBe(503);
    expect(unavailableResult.body.error.code).toBe('not_ready');
  });

  it('preserves progress after withdrawal and rejoin, while staff removal requires reinstatement', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const student = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const roadmap = await request(app).post(`/api/v1/organizations/${organization.body.id}/roadmaps`).set(owner)
      .send({ name: 'Plan', topics: [{ title: 'Topic' }] });
    await publishRoadmap(app, roadmap.body.version_id, owner);
    const cohort = await request(app).post(`/api/v1/organizations/${organization.body.id}/cohorts`).set(owner)
      .send({ name: 'Cohort', roadmap_version_id: roadmap.body.version_id });
    const code = cohort.body.invite_code;
    await request(app).post('/api/v1/cohorts/join').set(student).send({ invite_code: code });
    const topicId = roadmap.body.topics[0].id;
    await request(app).put(`/api/v1/progress/topics/${topicId}`).set(student).send({ completed: true });
    expect((await request(app).delete(`/api/v1/cohorts/${cohort.body.id}/enrollments/me`).set(student)).status).toBe(204);
    expect((await request(app).get('/api/v1/progress/me').set(student)).body).toEqual([]);
    expect((await request(app).post('/api/v1/cohorts/join').set(student).send({ invite_code: code })).status).toBe(200);
    expect((await request(app).get('/api/v1/progress/me').set(student)).body[0].completed).toBe(1);
    const enrollmentId = tables.cohortEnrollment[0].id;
    expect((await request(app).delete(`/api/v1/cohorts/${cohort.body.id}/enrollments/${enrollmentId}`).set(owner)).status).toBe(204);
    expect((await request(app).post('/api/v1/cohorts/join').set(student).send({ invite_code: code })).status).toBe(409);
    expect((await request(app).get(`/api/v1/cohorts/${cohort.body.id}/enrollments`).set(owner)).body).toMatchObject([
      { id: enrollmentId, status: 'inactive', end_reason: 'staff_removed' },
    ]);
    expect((await request(app).post(`/api/v1/cohorts/${cohort.body.id}/enrollments/${enrollmentId}/reactivate`).set(owner)).status).toBe(200);
    expect((await request(app).get('/api/v1/progress/me').set(student)).body[0].completed).toBe(1);
    expect(tables.topicProgress).toHaveLength(1);
  });

  it('rejects cross-tenant join-code and roster access', async () => {
    const { app } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const other = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const otherOrganization = await request(app).post('/api/v1/organizations').set(other).send({ name: 'Other Campus' });
    const roadmap = await request(app).post(`/api/v1/organizations/${organization.body.id}/roadmaps`).set(owner)
      .send({ name: 'Plan', topics: [{ title: 'Topic' }] });
    await publishRoadmap(app, roadmap.body.version_id, owner);
    const cohort = await request(app).post(`/api/v1/organizations/${organization.body.id}/cohorts`).set(owner)
      .send({ name: 'Cohort', roadmap_version_id: roadmap.body.version_id });
    expect((await request(app).post(`/api/v1/cohorts/${cohort.body.id}/join-code/rotate`).set(other)).status).toBe(403);
    expect((await request(app).get(`/api/v1/cohorts/${cohort.body.id}/enrollments`).set(other)).status).toBe(403);
    expect((await request(app).get(`/api/v1/organizations/${otherOrganization.body.id}/cohorts`).set(other)).body).toEqual([]);
  });
});

describe('organization management reads', () => {
  it('shows only an active owner the organization and safe member directory', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const student = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const outsider = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const created = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const path = '/api/v1/organizations/' + created.body.id;
    const detail = await request(app).get(path).set(owner);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: created.body.id, name: 'Campus', role: 'owner' });
    const members = await request(app).get(path + '/members').set(owner);
    expect(members.status).toBe(200);
    expect(members.body).toMatchObject([{ user_id: owner['X-Test-User'], display_name: 'Coordinator', role: 'owner', status: 'active' }]);
    expect(members.body[0]).not.toHaveProperty('password_hash');
    expect((await request(app).get(path + '/members').set(student)).status).toBe(403);
    expect((await request(app).get(path).set(outsider)).status).toBe(403);
    tables.organizationMembership[0].status = 'inactive';
    expect((await request(app).get(path).set(owner)).status).toBe(403);
    expect((await request(app).get(path + '/members').set(owner)).status).toBe(403);
  });

  it('lets an owner manage non-owner membership without demoting themselves or crossing tenants', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const other = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const otherOrganization = await request(app).post('/api/v1/organizations').set(other).send({ name: 'Other Campus' });
    const staffId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    tables.user.push({ id: staffId, displayName: 'Staff', primaryEmail: 'staff@example.edu', accountType: 'coordinator', status: 'active' });
    const staff = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', organizationId: organization.body.id,
      userId: staffId, role: 'coordinator', status: 'active', joinedAt: new Date() };
    tables.organizationMembership.push(staff);
    const path = `/api/v1/organizations/${organization.body.id}/members/${staff.id}`;
    const changed = await request(app).patch(path).set(owner).send({ role: 'mentor', status: 'inactive' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ id: staff.id, role: 'mentor', status: 'inactive' });
    expect(tables.organizationMembership.find((row) => row.id === staff.id)).toMatchObject({ role: 'mentor', status: 'inactive' });
    const ownerMembership = tables.organizationMembership.find((row) => row.userId === owner['X-Test-User']);
    expect((await request(app).patch(`/api/v1/organizations/${organization.body.id}/members/${ownerMembership.id}`)
      .set(owner).send({ status: 'inactive' })).status).toBe(403);
    expect((await request(app).patch(path).set(other).send({ status: 'active' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/organizations/${otherOrganization.body.id}/members/${staff.id}`)
      .set(other).send({ status: 'active' })).status).toBe(404);
  });

  it('transfers ownership atomically to active staff and rejects a missing target', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const nextOwner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const targetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    tables.user.push({ id: nextOwner['X-Test-User'], displayName: 'Next owner', primaryEmail: 'next@example.edu', accountType: 'coordinator', status: 'active' });
    tables.organizationMembership.push({ id: targetId, organizationId: organization.body.id,
      userId: nextOwner['X-Test-User'], role: 'coordinator', status: 'active', joinedAt: new Date() });
    const path = `/api/v1/organizations/${organization.body.id}/ownership-transfer`;
    expect((await request(app).post(path).set(owner).send({ membership_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })).status).toBe(404);
    const transferred = await request(app).post(path).set(owner).send({ membership_id: targetId });
    expect(transferred.status).toBe(200);
    expect(tables.organizationMembership.find((row) => row.id === targetId).role).toBe('owner');
    expect(tables.organizationMembership.find((row) => row.userId === owner['X-Test-User']).role).toBe('coordinator');
    expect((await request(app).get(`/api/v1/organizations/${organization.body.id}/members`).set(owner)).status).toBe(403);
    expect((await request(app).get(`/api/v1/organizations/${organization.body.id}/members`).set(nextOwner)).status).toBe(200);
  });
});

describe('organization staff invitations', () => {
  it('issues a one-time invitation and permits only its verified-email coordinator to accept', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const invited = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const path = `/api/v1/organizations/${organization.body.id}/invitations`;
    tables.user.push({ id: invited['X-Test-User'], displayName: 'Invited', primaryEmail: 'invited@example.edu',
      emailVerifiedAt: new Date(), accountType: 'coordinator', status: 'active' });
    const issued = await request(app).post(path).set(owner).send({ email: ' Invited@Example.edu ', role: 'mentor' });
    expect(issued.status).toBe(201);
    expect(issued.body.code.length).toBeGreaterThanOrEqual(40);
    expect(tables.organizationInvitation[0].tokenHash).not.toBe(issued.body.code);
    const listed = await request(app).get(path).set(owner);
    expect(listed.status).toBe(200);
    expect(listed.body[0]).toMatchObject({ email: 'invited@example.edu', role: 'mentor', status: 'pending' });
    expect(listed.body[0]).not.toHaveProperty('code');
    expect((await request(app).get(path).set(invited)).status).toBe(403);
    expect((await request(app).post('/api/v1/organization-invitations/accept').set(owner)
      .send({ code: issued.body.code })).status).toBe(403);
    tables.user.find((user) => user.id === invited['X-Test-User']).emailVerifiedAt = null;
    expect((await request(app).post('/api/v1/organization-invitations/accept').set(invited)
      .send({ code: issued.body.code })).status).toBe(403);
    tables.user.find((user) => user.id === invited['X-Test-User']).emailVerifiedAt = new Date();
    const accepted = await request(app).post('/api/v1/organization-invitations/accept').set(invited)
      .send({ code: issued.body.code });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ organization_id: organization.body.id, role: 'mentor' });
    expect((await request(app).post('/api/v1/organization-invitations/accept').set(invited)
      .send({ code: issued.body.code })).status).toBe(404);
    expect(tables.organizationMembership.filter((row) => row.userId === invited['X-Test-User'])).toHaveLength(1);
  });

  it('rotates and revokes codes, blocks expired codes and existing memberships', async () => {
    const { app, tables } = workflowFixture();
    const owner = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const invited = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    tables.user.push({ id: invited['X-Test-User'], displayName: 'Invited', primaryEmail: 'invited@example.edu',
      emailVerifiedAt: new Date(), accountType: 'coordinator', status: 'active' });
    const organization = await request(app).post('/api/v1/organizations').set(owner).send({ name: 'Campus' });
    const path = `/api/v1/organizations/${organization.body.id}/invitations`;
    const first = await request(app).post(path).set(owner).send({ email: 'invited@example.edu', role: 'admin' });
    const rotated = await request(app).post(path).set(owner).send({ email: 'invited@example.edu', role: 'mentor' });
    expect(rotated.status).toBe(201);
    expect((await request(app).post('/api/v1/organization-invitations/accept').set(invited)
      .send({ code: first.body.code })).status).toBe(404);
    const invitation = tables.organizationInvitation[0];
    invitation.expiresAt = new Date('2020-01-01');
    expect((await request(app).post('/api/v1/organization-invitations/accept').set(invited)
      .send({ code: rotated.body.code })).status).toBe(404);
    invitation.expiresAt = new Date(Date.now() + 86_400_000);
    expect((await request(app).delete(`${path}/${invitation.id}`).set(owner)).status).toBe(204);
    expect((await request(app).post('/api/v1/organization-invitations/accept').set(invited)
      .send({ code: rotated.body.code })).status).toBe(404);
    tables.organizationMembership.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      organizationId: organization.body.id, userId: invited['X-Test-User'], role: 'mentor', status: 'inactive' });
    expect((await request(app).post(path).set(owner).send({ email: 'invited@example.edu', role: 'mentor' })).status).toBe(409);
  });
});

describe('FastAPI rounding compatibility', () => {
  it('rounds a half percentage to the nearest even integer', async () => {
    const { app } = workflowFixture();
    const coordinator = { 'X-Test-Role': 'coordinator' };
    const student = { 'X-Test-Role': 'student', 'X-Test-User': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const org = await request(app).post('/api/v1/organizations').set(coordinator).send({ name: 'Campus' });
    const roadmap = await request(app)
      .post('/api/v1/organizations/' + org.body.id + '/roadmaps')
      .set(coordinator)
      .send({ name: 'Eight topics', topics: Array.from({ length: 8 }, (_, index) => ({ title: 'Topic ' + index })) });
    await publishRoadmap(app, roadmap.body.version_id, coordinator);
    const cohort = await request(app)
      .post('/api/v1/organizations/' + org.body.id + '/cohorts')
      .set(coordinator)
      .send({ name: '2026 cohort', roadmap_version_id: roadmap.body.version_id });
    await request(app).post('/api/v1/cohorts/join').set(student).send({ invite_code: cohort.body.invite_code });
    await request(app).put('/api/v1/progress/topics/' + roadmap.body.topics[0].id).set(student).send({ completed: true });
    const mine = await request(app).get('/api/v1/progress/me').set(student);
    expect(mine.body[0].percent).toBe(12);
  });
});

describe('organization boundary', () => {
  it('does not let an owner attach another organization’s roadmap version', async () => {
    const { app } = workflowFixture();
    const ownerA = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const ownerB = { 'X-Test-Role': 'coordinator', 'X-Test-User': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const first = await request(app).post('/api/v1/organizations').set(ownerA).send({ name: 'First Campus' });
    const second = await request(app).post('/api/v1/organizations').set(ownerB).send({ name: 'Other Campus' });
    const roadmap = await request(app)
      .post('/api/v1/organizations/' + first.body.id + '/roadmaps')
      .set(ownerA)
      .send({ name: 'First roadmap', topics: [{ title: 'Set goals' }] });
    expect((await request(app)
      .post('/api/v1/organizations/' + second.body.id + '/cohorts')
      .set(ownerB)
      .send({ name: 'Wrong cohort', roadmap_version_id: roadmap.body.version_id })).status).toBe(404);
    expect((await request(app).get('/api/v1/organizations/' + first.body.id + '/roadmaps').set(ownerB)).status).toBe(403);
  });
});
