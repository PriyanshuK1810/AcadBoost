import { publishRoadmap } from '../helpers/roadmapWorkflow.js';
import { registerRoadmapRoutes } from '../../src/modules/learning/roadmapRoutes.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { errorHandler } from '../../src/core/errors.js';
import { createPrismaClient } from '../../src/db/client.js';
import { createRequireUser, issueSession } from '../../src/modules/auth/service.js';
import { registerLearningRoutes } from '../../src/modules/learning/routes.js';
import { registerReviewRoutes } from '../../src/modules/review/routes.js';
import { removeTestOrganizations } from './cleanup.js';

describe.skipIf(!(process.env.OUTPOST_DATABASE_URL || process.env.DATABASE_URL))('PostgreSQL authorization policies', () => {
  test('enforces live roles, enrollment, resource parents, and suspended-user revocation', async () => {
    const prisma = createPrismaClient();
    const suffix = randomUUID().replaceAll('-', '');
    const settings = { authSigningKey: 'phase13-test-signing-key-long-enough-for-hs256' };
    const users = [];
    const organizations = [];
    const createUser = async (label, accountType = 'coordinator') => {
      const user = await prisma.user.create({ data: {
        displayName: label, username: `p13_${label}_${suffix}`,
        primaryEmail: `p13_${label}_${suffix}@example.edu`, accountType,
      } });
      users.push(user.id);
      return user;
    };
    const createOrganization = async (name, owner) => {
      const organization = await prisma.organization.create({ data: {
        name, slug: `p13-${name.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
      } });
      organizations.push(organization.id);
      await prisma.organizationMembership.create({ data: {
        organizationId: organization.id, userId: owner.id, role: 'owner',
      } });
      return organization;
    };
    const createPublishedRoadmap = async (organization, actor, name) => {
      const roadmap = await prisma.roadmap.create({ data: {
        organizationId: organization.id, name, createdBy: actor.id,
      } });
      const version = await prisma.roadmapVersion.create({ data: {
        roadmapId: roadmap.id, versionNumber: 1, status: 'draft', createdBy: actor.id,
      } });
      const phase = await prisma.phase.create({ data: {
        roadmapVersionId: version.id, title: 'Learning path', orderIndex: 1,
      } });
      const week = await prisma.week.create({ data: { phaseId: phase.id, title: 'Week 1', orderIndex: 1 } });
      const topic = await prisma.topic.create({ data: {
        weekId: week.id, title: `${name} topic`, description: '', orderIndex: 1,
      } });
      const fixtureApp = express(); fixtureApp.use(express.json());
      registerRoadmapRoutes(fixtureApp, { prisma, requireUser: (req, _res, next) => { req.user={id:actor.id,account_type:actor.accountType}; next(); } });
      fixtureApp.use(errorHandler);
      await publishRoadmap(fixtureApp, version.id);
      const published = await prisma.roadmapVersion.findUnique({where:{id:version.id}});
      return { roadmap, version: published, topic };
    };
    const createCohort = async (organization, actor, version, name) => prisma.cohort.create({ data: {
      organizationId: organization.id, roadmapVersionId: version.id, name, createdBy: actor.id,
      inviteCodeHash: randomUUID().replaceAll('-', '').repeat(2),
      inviteCodeExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    } });

    try {
      const ownerA = await createUser('ownera');
      const ownerB = await createUser('ownerb');
      const admin = await createUser('admin');
      const coordinator = await createUser('coordinator');
      const mentor = await createUser('mentor');
      const student = await createUser('student', 'student');
      const mismatched = await createUser('mismatched');
      const suspended = await createUser('suspended');
      const orgA = await createOrganization(`Campus A ${suffix}`, ownerA);
      const orgB = await createOrganization(`Campus B ${suffix}`, ownerB);
      const versionA = await createPublishedRoadmap(orgA, ownerA, 'Plan A');
      const versionB = await createPublishedRoadmap(orgB, ownerB, 'Plan B');
      const cohortA = await createCohort(orgA, ownerA, versionA.version, 'Cohort A');
      // The strict database now prevents corrupt tenant pins instead of allowing a fixture to fabricate one.
      await expect(createCohort(orgA, ownerA, versionB.version, 'Mismatched cohort')).rejects.toThrow();
      const corruptCohort = { id: randomUUID() };
      await prisma.organizationMembership.createMany({ data: [
        { organizationId: orgA.id, userId: admin.id, role: 'admin' },
        { organizationId: orgA.id, userId: coordinator.id, role: 'coordinator' },
        { organizationId: orgA.id, userId: mentor.id, role: 'mentor' },
        { organizationId: orgA.id, userId: student.id, role: 'student' },
        { organizationId: orgA.id, userId: mismatched.id, role: 'student' },
        { organizationId: orgA.id, userId: suspended.id, role: 'admin' },
      ] });
      await prisma.cohortEnrollment.createMany({ data: [
        { cohortId: cohortA.id, userId: student.id },
        { cohortId: cohortA.id, userId: mismatched.id },
      ] });

      const app = express();
      app.use(express.json());
      const requireUser = createRequireUser(prisma, settings);
      registerLearningRoutes(app, { prisma, settings, requireUser, redisClient: { eval: async () => 1 } });
      registerReviewRoutes(app, { prisma, settings, requireUser });
      app.get('/api/v1/test/current-user', requireUser, (req, res) => res.json({ id: req.user.id }));
      app.use(errorHandler);
      const tokens = new Map();
      const auth = async (user) => {
        if (!tokens.has(user.id)) {
          tokens.set(user.id, await issueSession(prisma, settings, user, 'test', { get: () => undefined }));
        }
        return { Authorization: `Bearer ${tokens.get(user.id).access}` };
      };

      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(ownerA))).status).toBe(200);
      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(admin))).status).toBe(200);
      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(coordinator))).status).toBe(200);
      expect((await request(app).get('/api/v1/organizations').set(await auth(admin))).body)
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: orgA.id, role: 'admin' })]));
      expect((await request(app).get('/api/v1/organizations').set(await auth(mismatched))).body).toEqual([]);
      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/members`).set(await auth(admin))).status).toBe(403);
      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(mentor))).status).toBe(403);
      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(student))).status).toBe(403);
      expect((await request(app).get(`/api/v1/organizations/${orgB.id}/roadmaps`).set(await auth(coordinator))).status).toBe(403);
      expect((await request(app).get(`/api/v1/organizations/${randomUUID()}/roadmaps`).set(await auth(ownerA))).status).toBe(403);
      await prisma.organizationMembership.create({ data: {
        organizationId: orgB.id, userId: coordinator.id, role: 'coordinator',
      } });
      expect((await request(app).get(`/api/v1/organizations/${orgB.id}/roadmaps`).set(await auth(coordinator))).status).toBe(200);
      expect((await request(app).post(`/api/v1/organizations/${orgB.id}/cohorts`).set(await auth(coordinator))
        .send({ name: 'Cross-tenant cohort', roadmap_version_id: versionA.version.id })).status).toBe(404);
      expect((await request(app).post(`/api/v1/organizations/${orgA.id}/invitations`).set(await auth(admin))
        .send({ email: `blocked_${suffix}@example.edu`, role: 'mentor' })).status).toBe(403);
      expect((await request(app).post(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(admin))
        .send({ name: 'Admin plan', topics: [{ title: 'Admin topic' }] })).status).toBe(201);
      const adminCohort = await request(app).post(`/api/v1/organizations/${orgA.id}/cohorts`).set(await auth(admin))
        .send({ name: 'Admin cohort', roadmap_version_id: versionA.version.id });
      expect(adminCohort.status).toBe(201);
      expect((await request(app).post(`/api/v1/organizations/${orgA.id}/cohorts`).set(await auth(coordinator))
        .send({ name: 'Coordinator cohort', roadmap_version_id: versionA.version.id })).status).toBe(201);
      expect((await request(app).post(`/api/v1/organizations/${orgA.id}/cohorts`).set(await auth(admin))
        .send({ name: 'Cross-parent cohort', roadmap_version_id: versionB.version.id })).status).toBe(404);
      expect((await request(app).post(`/api/v1/organizations/${orgA.id}/cohorts`).set(await auth(mentor))
        .send({ name: 'Mentor cohort', roadmap_version_id: versionA.version.id })).status).toBe(403);
      const listedCohorts = await request(app).get(`/api/v1/organizations/${orgA.id}/cohorts`).set(await auth(admin));
      expect(listedCohorts.body.map((cohort) => cohort.id)).toEqual(expect.arrayContaining([cohortA.id, adminCohort.body.id]));
      expect(listedCohorts.body.map((cohort) => cohort.id)).not.toContain(corruptCohort.id);

      const report = await request(app).get(`/api/v1/cohorts/${cohortA.id}/progress`).set(await auth(admin));
      expect(report.status).toBe(200);
      expect(report.body.students.map((row) => row.id)).toEqual([student.id]);
      expect((await request(app).get(`/api/v1/cohorts/${cohortA.id}/progress`).set(await auth(coordinator))).status).toBe(200);
      expect((await request(app).get(`/api/v1/cohorts/${cohortA.id}/progress`).set(await auth(mentor))).status).toBe(403);
      expect((await request(app).get(`/api/v1/cohorts/${cohortA.id}/progress`).set(await auth(student))).status).toBe(403);
      expect((await request(app).get(`/api/v1/cohorts/${corruptCohort.id}/progress`).set(await auth(ownerA))).status).toBe(404);
      expect((await request(app).post('/api/v1/cohorts/join').set(await auth(student))
        .send({ invite_code: randomUUID() })).status).toBe(404);
      expect((await request(app).put(`/api/v1/progress/topics/${versionB.topic.id}`)
        .set(await auth(student)).send({ completed: true })).status).toBe(404);
      expect((await request(app).put(`/api/v1/progress/topics/${versionA.topic.id}`)
        .set(await auth(mismatched)).send({ completed: true })).status).toBe(403);
      expect((await request(app).get('/api/v1/progress/me').set(await auth(student))).body).toHaveLength(1);
      expect((await request(app).get('/api/v1/progress/me').set(await auth(mismatched))).status).toBe(403);
      expect((await request(app).put('/api/v1/review/progress/goals').set(await auth(coordinator))
        .send({ completed: true })).status).toBe(403);
      expect((await request(app).put('/api/v1/review/progress/goals').set(await auth(student))
        .send({ completed: true })).status).toBe(200);
      const illustrative = await request(app).get('/api/v1/review/overview').set(await auth(coordinator));
      expect(illustrative.body).toMatchObject({ scenario: 'illustrative', coordinator: { cohort_title: expect.any(String) } });

      await prisma.organizationMembership.updateMany({ where: { organizationId: orgA.id, userId: admin.id },
        data: { status: 'inactive' } });
      expect((await request(app).get(`/api/v1/organizations/${orgA.id}/roadmaps`).set(await auth(admin))).status).toBe(403);
      expect((await request(app).get(`/api/v1/cohorts/${cohortA.id}/progress`).set(await auth(admin))).status).toBe(403);
      await prisma.cohortEnrollment.updateMany({ where: { cohortId: cohortA.id, userId: student.id },
        data: { status: 'inactive', endedAt: new Date(), endedBy: ownerA.id, endReason: 'staff_removed' } });
      expect((await request(app).get('/api/v1/progress/me').set(await auth(student))).body).toEqual([]);
      expect((await request(app).put(`/api/v1/progress/topics/${versionA.topic.id}`)
        .set(await auth(student)).send({ completed: true })).status).toBe(404);

      const suspendedSession = await auth(suspended);
      await prisma.user.update({ where: { id: suspended.id }, data: { status: 'suspended' } });
      expect((await request(app).get('/api/v1/test/current-user').set(suspendedSession)).status).toBe(401);
    } finally {
      await removeTestOrganizations(prisma, organizations, users);
      await prisma.$disconnect();
    }
  }, 30_000);
});
