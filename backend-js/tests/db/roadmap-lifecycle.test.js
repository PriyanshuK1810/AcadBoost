import { publishRoadmap, submitRoadmap, archiveRoadmap } from '../helpers/roadmapWorkflow.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { errorHandler } from '../../src/core/errors.js';
import { createPrismaClient } from '../../src/db/client.js';
import { registerLearningRoutes } from '../../src/modules/learning/routes.js';
import { removeTestOrganizations } from './cleanup.js';

describe.skipIf(!(process.env.OUTPOST_DATABASE_URL || process.env.DATABASE_URL))('roadmap version lifecycle in PostgreSQL', () => {
  test('preserves pinned cohorts, freezes published history, and serializes publication', async () => {
    const prisma = createPrismaClient();
    const suffix = randomUUID().replaceAll('-', '');
    const users = [];
    const organizations = [];
    const makeUser = async (name, accountType) => {
      const user = await prisma.user.create({ data: {
        displayName: name, username: `p14_${name}_${suffix}`, accountType,
      } });
      users.push(user.id);
      return user;
    };
    const makeOrganization = async (name, owner) => {
      const organization = await prisma.organization.create({ data: {
        name, slug: `p14-${name.toLowerCase()}-${suffix}`,
      } });
      organizations.push(organization.id);
      await prisma.organizationMembership.create({ data: {
        organizationId: organization.id, userId: owner.id, role: 'owner',
      } });
      return organization;
    };
    try {
      const owner = await makeUser('owner', 'coordinator');
      const other = await makeUser('other', 'coordinator');
      const student = await makeUser('student', 'student');
      const org = await makeOrganization('Campus', owner);
      const foreignOrg = await makeOrganization('Other', other);
      await prisma.organizationMembership.create({ data: {
        organizationId: org.id, userId: student.id, role: 'student',
      } });
      const app = express();
      app.use(express.json());
      const requireUser = (req, _res, next) => {
        const actor = req.get('X-Actor');
        req.user = actor === 'student'
          ? { id: student.id, account_type: 'student' }
          : actor === 'other'
            ? { id: other.id, account_type: 'coordinator' }
            : { id: owner.id, account_type: 'coordinator' };
        next();
      };
      registerLearningRoutes(app, { prisma, settings: {}, requireUser });
      app.use(errorHandler);
      const base = `/api/v1/organizations/${org.id}/roadmaps`;
      const created = await request(app).post(base).send({
        name: 'Career plan', topics: [{ title: 'First topic' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('draft');
      const path = `${base}/${created.body.id}/versions/${created.body.version_id}`;
      expect((await request(app).post(`/api/v1/organizations/${org.id}/cohorts`).send({
        name: 'Cohort', roadmap_version_id: created.body.version_id,
      })).status).toBe(404);
      const incomplete = await request(app).patch(`/api/v1/roadmap-versions/${created.body.version_id}`)
        .send({ revision: created.body.revision, phases: [{ title: 'Phase 1', weeks: [] }] });
      expect(incomplete.status).toBe(200);
      expect((await request(app).post(`${path}/submit`).send({revision:incomplete.body.revision})).status).toBe(422);
      expect((await request(app).post(`${path}/publish`).send({revision:incomplete.body.revision,submission_id:randomUUID()})).status).toBe(409);
      await expect(prisma.roadmapVersion.update({
        where: { id: created.body.version_id }, data: { status: 'published', publishedAt: new Date() },
      })).rejects.toThrow();
      const edited = await request(app).put(path).send({ revision: incomplete.body.revision, phases: [{
        title: 'Preparation', weeks: [{ title: 'Week one', topics: [{ title: 'Build skills', description: 'Practice' }] }],
      }] });
      expect(edited.status).toBe(200);
      expect(edited.body.phases[0].weeks[0].topics[0].title).toBe('Build skills');
      const submitted = await submitRoadmap(app, created.body.version_id);
      const decision={revision:submitted.revision,submission_id:submitted.pending_submission.id};
      const publish = await Promise.all([
        request(app).post(`${path}/publish`).send(decision), request(app).post(`${path}/publish`).send(decision),
      ]);
      const published=publish.find(result=>result.status===200);
      expect(publish.map((result) => result.status).sort()).toEqual([200, 409]);
      expect((await request(app).put(path).send({ revision: published.body.revision, phases: [] })).status).toBe(409);
      await expect(prisma.topic.update({
        where: { id: edited.body.topics[0].id }, data: { title: 'Tampered' },
      })).rejects.toThrow();
      await expect(prisma.topic.create({ data: {
        weekId: edited.body.phases[0].weeks[0].id, title: 'Injected', orderIndex: 2,
      } })).rejects.toThrow();
      const cohort = await request(app).post(`/api/v1/organizations/${org.id}/cohorts`).send({
        name: 'First cohort', roadmap_version_id: created.body.version_id,
      });
      expect(cohort.status).toBe(201);
      await prisma.cohortEnrollment.create({ data: { cohortId: cohort.body.id, userId: student.id } });
      expect((await request(app).put(`/api/v1/progress/topics/${edited.body.topics[0].id}`)
        .set('X-Actor', 'student').send({ completed: true })).status).toBe(204);
      const copy = await request(app).post(`${base}/${created.body.id}/versions`).send({
        source_version_id: created.body.version_id, revision: published.body.revision,
      });
      expect(copy.status).toBe(201);
      expect(copy.body.version_number).toBe(2);
      expect(copy.body.status).toBe('draft');
      expect(copy.body.topics[0].id).not.toBe(edited.body.topics[0].id);
      const concurrentCopies = await Promise.all([
        request(app).post(`${base}/${created.body.id}/versions`).send({ source_version_id: created.body.version_id, revision: published.body.revision }),
        request(app).post(`${base}/${created.body.id}/versions`).send({ source_version_id: created.body.version_id, revision: published.body.revision }),
      ]);
      expect(concurrentCopies.map((result) => result.status)).toEqual([201, 201]);
      expect(concurrentCopies.map((result) => result.body.version_number).sort()).toEqual([3, 4]);
      expect((await request(app).post(`${base}/${created.body.id}/versions`).send({
        source_version_id: copy.body.version_id, revision: copy.body.revision,
      })).status).toBe(409);
      expect((await request(app).post(`/api/v1/organizations/${org.id}/cohorts`).send({
        name: 'Draft cohort', roadmap_version_id: copy.body.version_id,
      })).status).toBe(404);
      expect((await request(app).get(path).set('X-Actor', 'other')).status).toBe(403);
      expect((await request(app).get(`/api/v1/roadmaps/${created.body.id}/versions`)).body).toHaveLength(4);
      expect((await request(app).get(`/api/v1/roadmap-versions/${created.body.version_id}`)).body.status).toBe('published');
      expect((await request(app).get(`${base}/${created.body.id}/versions`).set('X-Actor', 'student')).status).toBe(403);
      expect((await request(app).put(path).set('X-Actor', 'student').send({ phases: [] })).status).toBe(403);
      expect((await request(app).post(`${path}/archive`).set('X-Actor', 'other')).status).toBe(403);
      expect((await request(app).get(`/api/v1/organizations/${foreignOrg.id}/roadmaps/${created.body.id}/versions/${created.body.version_id}`)
        .set('X-Actor', 'other')).status).toBe(404);
      const sibling = await request(app).post(base).send({ name: 'Sibling plan', topics: [{ title: 'Other topic' }] });
      expect((await request(app).get(`${base}/${sibling.body.id}/versions/${created.body.version_id}`)).status).toBe(404);
      const archived = await archiveRoadmap(app, created.body.version_id);
      expect(archived.status).toBe(200);
      expect(archived.body.status).toBe('archived');
      await expect(prisma.topic.delete({ where: { id: edited.body.topics[0].id } })).rejects.toThrow();
      expect((await request(app).post(`/api/v1/organizations/${org.id}/cohorts`).send({
        name: 'Late cohort', roadmap_version_id: created.body.version_id,
      })).status).toBe(404);
      expect((await request(app).get('/api/v1/progress/me').set('X-Actor', 'student')).body[0])
        .toMatchObject({ completed: 1, total: 1 });
      expect((await request(app).get(`/api/v1/cohorts/${cohort.body.id}/progress`)).body)
        .toMatchObject({ students: [{ completed: 1, total: 1 }] });
      expect((await prisma.cohort.findUnique({ where: { id: cohort.body.id } })).roadmapVersionId)
        .toBe(created.body.version_id);
      expect((await prisma.roadmapVersion.findUnique({ where: { id: created.body.version_id } })).versionNumber)
        .toBe(1);
      expect((await publishRoadmap(app, copy.body.version_id)).status).toBe(200);
      expect((await request(app).get(`${base}/${created.body.id}/versions`)).body.map((row) => row.status))
        .toEqual(['archived', 'published', 'draft', 'draft']);
    } finally {
      await removeTestOrganizations(prisma, organizations, users);
      await prisma.$disconnect();
    }
  }, 30_000);
});
